/* study-ask: answers a student's question about one study material with the Claude API, streamed.
 *
 * Deno, deployed as a Supabase Edge Function beside saq-grade. The caller is a material that
 * carries the 'ai-ask' tag, and only while the 'ask' row in study_ai_features is on.
 *
 * What this file is responsible for:
 *   validating the request before it costs anything,
 *   asking Postgres for permission and a budget (ai_begin2, feature 'ask'),
 *   streaming exactly one Claude call with the prompt in ask_prompt.mjs as Server Sent Events,
 *   closing the ledger row exactly once (ai_end), whatever happened, including a client that
 *   disconnects halfway,
 *   saving the question and the answer once, as one study_ai_chats row through ai_chat_log
 *   (0012, the owner only beta), after the answer has finished or failed, and handing the row id
 *   back in the done event as chat_id,
 *   returning a small fixed set of error codes and never the API's own error text,
 *   and, for a request with purpose 'trap' (migration 0024), one short call that is not streamed
 *   and answers a two line trap note as JSON, under the 'trap' row's own switch and cap
 *   (trapNote below).
 *
 * What it never does: log, echo or return the API key; log the question, the passages or the
 * answer, or store them anywhere but that one row; leave a pending ledger row open; let a failed
 * chat row get in the way of the answer.
 *
 * Environment:
 *   ANTHROPIC_API_KEY          Edge Function secret, shared with saq-grade.
 *   SUPABASE_URL               injected by the platform.
 *   SUPABASE_SERVICE_ROLE_KEY  injected by the platform. ai_begin2, ai_end and ai_chat_log are
 *                              granted to service_role only, so the anon key cannot reach them.
 *
 * Request, events, error codes and deploy: README.md beside this file.
 * No em dashes and no en dashes in this file.
 */
import Anthropic, { RateLimitError, APIConnectionError, APIError, APIUserAbortError } from "npm:@anthropic-ai/sdk";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  FEATURE,
  LIST_RE,
  INTENT_EFFORT,
  INTENT_MODEL,
  INTENT_SYSTEM,
  LIMITS,
  PRICES,
  RESERVE_OUT,
  buildRequest,
  estimateInputTokens,
  validateAsk,
  TRAP_FEATURE,
  TRAP_MAX_TOKENS,
  buildTrapRequest,
  cleanTrapNote,
  purposeOf,
  validateTrap,
} from "./ask_prompt.mjs";

/* ---------------------------------------------------------------- configuration */

const ALLOWED_ORIGINS = [
  "https://ayatdzcollection-sketch.github.io",
  "http://localhost:8000",
];

/* One attempt, 60 seconds for the whole stream. The SDK's own timeout only covers the wait for
   the response headers, so a wall clock timer below aborts a stream that runs past it. */
const CALL_TIMEOUT_MS = 60_000;
const CALL_MAX_RETRIES = 0;

/* The chat row keeps at most this much answer; ai_chat_log clips to the same. 700 tokens of
   answer is nowhere near it. */
const ANSWER_MAX = 6000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

/* Supabase's runtime global. It keeps the worker alive for work that outlives the response,
   which is where ai_end runs when a client disconnects. Absent under plain Deno. */
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/* ---------------------------------------------------------------- small helpers */

type Json = Record<string, unknown>;

type AskBody = {
  material: string;
  install: string;
  adminToken: string | null;
  question: string;
  quote: string;
  focus: string;
  map: string;
  chunks: Array<{ label: string; text: string; ref?: string }>;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  progress: string;
  notes: string;
  thread: string | null;
  turn: number;
  textbook: boolean;
  practice: boolean;
  widgets: boolean;
  math: boolean;
  effort: string;
  level?: string;
  intent?: string;
  beyond?: boolean;
  chapter: number | null;
  textbookLabels?: string[];
};

/* A request for a list, a set to copy out, or everything on a topic. Those answers are long by
   nature, and the 700 token answer was cutting them in half. */
const LIST_MAX_TOKENS = 1500;

/* Which private textbook corpus (migration 0013) a material may draw on. */
const CORPUS: Record<string, string> = {
  "apush/period1-2-test": "fraser-1-4",
  "apush/fraser-ch1-2": "fraser-1-4",
  "apush/fraser-ch3-4": "fraser-1-4",
  "apush/fraser-review": "fraser-1-4",
};
const TEXTBOOK_PASSAGES = 3;
const TEXTBOOK_CHARS = 1000;

type EndStatus = "ok" | "refused" | "error";

type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "authorization, apikey, content-type";
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function reply(body: Json, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

/* The ledger and the caps only ever see this, never a name and never any question text. */
function clientIp(req: Request): string {
  /* The last entry is the hop the platform itself appended; the first is whatever the
     caller chose to send, so it never gates anything that costs money. */
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
}

async function rpc(fn: string, body: Json): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    /* Status only. A PostgREST body can quote the arguments back, and the arguments of
       ai_begin2 include the visitor's address. */
    throw new Error(`rpc ${fn} failed with ${res.status}`);
  }
  return await res.json();
}

function keepAlive(p: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(p);
  }
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/* The ledger prices input at the plain rate, so cache writes (1.25 times) and cache reads
   (a tenth) are folded into the input count at what they actually cost. The spend cap then
   stays true whether or not the cache was hit. */
function effectiveIn(u: Usage): number {
  return Math.ceil(num(u.input_tokens) + 1.25 * num(u.cache_creation_input_tokens) + 0.1 * num(u.cache_read_input_tokens));
}

function dollars(model: string, inTok: number, outTok: number): number {
  /* An unknown model is priced at the dearest candidate so the number shown can never be
     lower than what was actually billed. Postgres computes the ledger's own figure. */
  const price = (PRICES as Record<string, { in: number; out: number }>)[model] ?? { in: 5, out: 25 };
  return (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
}

function costCents(model: string, inTok: number, outTok: number): number {
  return Math.round(dollars(model, inTok, outTok) * 100 * 1000) / 1000;
}

/* The ledger's unit: dollars per million tokens times tokens, times 1e8 microcents per dollar,
   as a whole number (the column is a bigint). */
function costMicrocents(model: string, inTok: number, outTok: number): number {
  return Math.round(dollars(model, inTok, outTok) * 1e8);
}

/* ---------------------------------------------------------------- the stream */

const encoder = new TextEncoder();

/* Opens the SSE response for a call ai_begin2 has already let through. Every path out of here,
   including a throw, a timeout, a refusal and the client going away, reaches finish(), and
   finish() calls ai_end at most once. logChat() writes the chat row at most once: before done on
   an answer that finished, and after ai_end, best effort, on every other path. */
function streamAnswer(body: AskBody, callId: unknown, model: string, origin: string): Response {
  const started = Date.now();
  let status: EndStatus = "error";
  let usage: Usage = {};
  let ended = false;
  let closed = false;
  let cancelled = false;
  let timedOut = false;
  let live: { abort(): void } | null = null;
  let answer = "";
  let logged = false;

  const finish = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    try {
      await rpc("ai_end", {
        p_call_id: callId,
        p_status: status,
        p_in: effectiveIn(usage),
        p_out: num(usage.output_tokens),
        p_latency: Date.now() - started,
      });
    } catch {
      console.error("study-ask: ai_end failed");
    }
  };

  /* The chat row, with the same effective token counts ai_end records. Returns the row id, or
     null when the row was not written; it never throws, so a logging failure cannot break the
     answer. */
  const logChat = async (): Promise<number | string | null> => {
    if (logged) return null;
    logged = true;
    const inTok = effectiveIn(usage);
    const outTok = num(usage.output_tokens);
    try {
      const res = (await rpc("ai_chat_log", {
        p_row: {
          call_id: callId,
          material: body.material,
          feature: FEATURE,
          install: body.install,
          thread: body.thread,
          turn: body.turn,
          question: body.question,
          quote: body.quote,
          focus: body.focus.slice(0, LIMITS.focus),
          /* Every chunk's label in the order sent, so Sources: [n] in the answer is labels[n - 1]. */
          labels: body.chunks.map((c) => c.label),
          /* How much care it was given, and what auto read the question as. Which code asked is
             not sent from here: ai_chat_log reads it from the call the ledger opened. */
          level: body.level,
          intent: body.intent,
          progress: body.progress.length > 0,
          notes: body.notes.length > 0,
          answer: answer.slice(0, ANSWER_MAX),
          status,
          model,
          input_tokens: inTok,
          output_tokens: outTok,
          cost_microcents: costMicrocents(model, inTok, outTok),
          latency_ms: Date.now() - started,
        },
      })) as Record<string, unknown> | null;
      if (res && res.ok === true && (typeof res.id === "number" || typeof res.id === "string")) return res.id;
      console.error("study-ask: ai_chat_log refused the row");
    } catch {
      console.error("study-ask: ai_chat_log failed");
    }
    return null;
  };

  const run = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    const send = (event: Json): void => {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        closed = true;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      if (cancelled) return;
      const request = buildRequest({ model, ...body, effort: body.level }) as Record<string, unknown>;
      /* A question that asks for a list needs room for the list, whatever effort it is on. The
         test is on the question the student typed, here rather than in the page, so a forged
         request cannot buy a longer answer than the words it asked for. */
      if (LIST_RE.test(body.question)) {
        request.max_tokens = Math.max(Number(request.max_tokens) || 0, LIST_MAX_TOKENS);
      }
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const stream = client.messages.stream(
        { model, ...request } as never,
        { timeout: CALL_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES },
      );
      live = stream;
      timer = setTimeout(() => {
        timedOut = true;
        stream.abort();
      }, CALL_TIMEOUT_MS);
      /* The client may have gone between the check above and here. */
      if (cancelled) stream.abort();

      for await (const ev of stream) {
        if (ev.type === "message_start") {
          usage = { ...(ev.message.usage as Usage) };
        } else if (ev.type === "message_delta") {
          /* Running totals. Keep them so a stream cut short still records what it cost. */
          const d = ev.usage as Usage;
          for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
            if (typeof d[k] === "number") usage[k] = d[k];
          }
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
          answer += ev.delta.text;
          send({ type: "delta", text: ev.delta.text });
        }
      }

      const msg = await stream.finalMessage();
      clearTimeout(timer);
      timer = undefined;
      if (msg.usage) usage = { ...(msg.usage as Usage) };

      if (msg.stop_reason === "refusal") {
        /* Text may already have streamed. The client drops it on this event. */
        status = "refused";
        send({ type: "error", error: "refused" });
        return;
      }

      status = "ok";
      const done: Json = { type: "done", model, cost_cents: costCents(model, effectiveIn(usage), num(usage.output_tokens)) };
      if (body.textbookLabels && body.textbookLabels.length) done.textbook = body.textbookLabels;
      /* Which level this answer was given, so the panel can say what auto chose. */
      done.level = body.level;
      if (body.intent) done.intent = body.intent;
      const chatId = await logChat();
      if (chatId !== null) done.chat_id = chatId;
      send(done);
    } catch (e) {
      /* Most specific first. The abort, connection and rate limit classes are all subclasses of
         APIError in the TypeScript SDK. Nothing from the error reaches the client or the log. */
      status = "error";
      let kind = "unknown";
      if (cancelled) kind = "client_gone";
      else if (timedOut) kind = "timeout";
      else if (e instanceof APIUserAbortError) kind = "aborted";
      else if (e instanceof RateLimitError) kind = "rate_limit";
      else if (e instanceof APIConnectionError) kind = "connection";
      else if (e instanceof APIError) kind = `api_${e.status ?? 0}`;
      console.error(`study-ask: call failed (${kind})`);
      send({ type: "error", error: "grader_error" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      /* Close first so the student is not kept waiting on the ledger write; keepAlive holds the
         worker open until ai_end is done. */
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed or errored */
        }
      }
      await finish();
      /* Refused, failed, timed out or abandoned: still one row, with whatever text streamed. */
      await logChat();
    }
  };

  let work: Promise<void> | null = null;
  try {
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        work = run(controller);
        keepAlive(work);
      },
      cancel() {
        /* The client disconnected. Stop paying for tokens nobody will read; run() sees the abort,
           records status error with the tokens used so far, and calls ai_end. */
        cancelled = true;
        closed = true;
        if (live) live.abort();
      },
    });

    return new Response(readable, {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    /* Only reachable if the stream or the Response could not be built. If run() started it owns
       the row; otherwise close it here. finish() is idempotent either way. */
    console.error("study-ask: could not open the stream");
    cancelled = true;
    if (live) (live as { abort(): void }).abort();
    if (!work) keepAlive(finish().then(logChat));
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
}

/* ---------------------------------------------------------------- trap notes */

type TrapBody = {
  purpose: "trap";
  material: string;
  install: string;
  adminToken: string | null;
  question: string;
  options: string[];
  picked: number;
  answer: number;
  why: string;
  chunks: Array<{ label: string; text: string }>;
};

/* Two short lines, not streamed. Half the Ask budget is plenty. */
const TRAP_TIMEOUT_MS = 30_000;

/* The 'trap' feature (migration 0024), for a request with purpose 'trap': the same order as an
   Ask question (validate, ai_begin2 with feature 'trap', one call, ai_end exactly once), then a
   chat row for the owner, best effort, after the ledger is closed. The reply is JSON:
     { ok: true, note, model, cost_cents }
     { ok: false, error, spent: true, cost_cents }   the call was billed: a refusal, or a reply
                                                     that is not a two line note
     { ok: false, error }                             nothing was spent
   spent is what lets the page record that this card has had its one call. */
async function trapNote(raw: unknown, req: Request, origin: string): Promise<Response> {
  const body = validateTrap(raw) as TrapBody | null;
  if (!body) return reply({ ok: false, error: "bad_request" }, 400, origin);

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("study-ask: a required environment variable is not set");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }

  let begun: Record<string, unknown> | null;
  try {
    begun = (await rpc("ai_begin2", {
      p_feature: TRAP_FEATURE,
      p_material: body.material,
      p_install: body.install,
      p_ip: clientIp(req),
      p_token: body.adminToken,
      p_in: estimateInputTokens(buildTrapRequest({ model: DEFAULT_MODEL, ...body })),
      p_out: TRAP_MAX_TOKENS,
    })) as Record<string, unknown> | null;
  } catch {
    console.error("study-ask: ai_begin2 failed (trap)");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
  if (!begun || begun.ok !== true) {
    /* off, unavailable, owner_only, the caps and the pass refusals pass through, as for Ask. */
    const error = begun && typeof begun.error === "string" && begun.error ? begun.error : "grader_error";
    return reply({ ok: false, error }, 200, origin);
  }
  const callId = begun.call_id;
  if (typeof callId !== "number" && typeof callId !== "string") {
    console.error("study-ask: ai_begin2 returned no call id (trap)");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
  const model = typeof begun.model === "string" && begun.model ? begun.model : DEFAULT_MODEL;

  const started = Date.now();
  let status: EndStatus = "error";
  let usage: Usage = {};
  let text = "";
  let note: string | null = null;
  let error = "grader_error";
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = (await client.messages.create(
      { model, ...buildTrapRequest({ model, ...body }) } as never,
      { timeout: TRAP_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES },
    )) as unknown as { content: Array<{ type: string; text?: string }>; stop_reason: string | null; usage?: Usage };
    if (msg.usage) usage = { ...msg.usage };
    text = (msg.content || []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
    if (msg.stop_reason === "refusal") {
      status = "refused";
      error = "refused";
    } else {
      status = "ok";
      note = cleanTrapNote(text, msg.stop_reason);
      if (!note) error = "bad_note";
    }
  } catch (e) {
    /* Nothing from the error reaches the client or the log. */
    status = "error";
    let kind = "unknown";
    if (e instanceof APIUserAbortError) kind = "aborted";
    else if (e instanceof RateLimitError) kind = "rate_limit";
    else if (e instanceof APIConnectionError) kind = "connection";
    else if (e instanceof APIError) kind = `api_${e.status ?? 0}`;
    console.error(`study-ask: trap call failed (${kind})`);
  }

  const inTok = effectiveIn(usage);
  const outTok = num(usage.output_tokens);
  try {
    await rpc("ai_end", { p_call_id: callId, p_status: status, p_in: inTok, p_out: outTok, p_latency: Date.now() - started });
  } catch {
    console.error("study-ask: ai_end failed (trap)");
  }

  /* The owner reads trap notes beside the Ask chats (0012, feature 'trap'): the question, the
     option kept being picked as the quote, the key and why line as the focus, the passage labels
     and the note. A failed row never changes what the student gets. */
  keepAlive(
    rpc("ai_chat_log", {
      p_row: {
        call_id: callId,
        material: body.material,
        feature: TRAP_FEATURE,
        install: body.install,
        turn: 0,
        question: body.question,
        quote: body.options[body.picked],
        focus: ("Key: " + body.options[body.answer] + (body.why ? ". Why: " + body.why : "")).slice(0, LIMITS.focus),
        labels: body.chunks.map((c) => c.label),
        progress: false,
        notes: false,
        answer: (note ?? text).slice(0, ANSWER_MAX),
        status,
        model,
        input_tokens: inTok,
        output_tokens: outTok,
        cost_microcents: costMicrocents(model, inTok, outTok),
        latency_ms: Date.now() - started,
      },
    }).catch(() => console.error("study-ask: ai_chat_log failed (trap)")),
  );

  const cents = costCents(model, inTok, outTok);
  if (note) return reply({ ok: true, note, model, cost_cents: cents }, 200, origin);
  const spent = status !== "error" || inTok + outTok > 0;
  return reply(spent ? { ok: false, error, spent: true, cost_cents: cents } : { ok: false, error }, 200, origin);
}

/* ---------------------------------------------------------------- the handler */

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "forbidden" }, 403, null);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  /* Only the two origins the hub is served from, and the header must be present: a call with
     no Origin (curl, a script) is refused too. The smoke test sends the header. */
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "forbidden" }, 403, null);
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405, origin);

  /* Everything is checked before a single row or token is spent. Anything that fails is a flat
     400 with no detail: the client never sends these shapes by accident. */
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > LIMITS.body) return reply({ ok: false, error: "bad_request" }, 400, origin);
    raw = JSON.parse(text);
  } catch {
    return reply({ ok: false, error: "bad_request" }, 400, origin);
  }

  /* A trap note (purpose 'trap', migration 0024) takes its own short path; an unknown purpose is
     refused like any other bad shape. */
  const purpose = purposeOf(raw);
  if (purpose === null) return reply({ ok: false, error: "bad_request" }, 400, origin);
  if (purpose === "trap") return await trapNote(raw, req, origin);

  const body = validateAsk(raw) as AskBody | null;
  if (!body) return reply({ ok: false, error: "bad_request" }, 400, origin);

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    /* Not deployed fully. Say nothing about which piece is missing, and do not open a row. */
    console.error("study-ask: a required environment variable is not set");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }

  /* The reserve is sized from what is about to be sent. The model only changes request fields
     that carry no text, so the default stands in until ai_begin2 names the real one. */
  const estimate = estimateInputTokens(buildRequest({ model: DEFAULT_MODEL, ...body }));

  let begun: Record<string, unknown> | null;
  try {
    begun = (await rpc("ai_begin2", {
      p_feature: FEATURE,
      p_material: body.material,
      p_install: body.install,
      p_ip: clientIp(req),
      p_token: body.adminToken,
      p_in: estimate,
      p_out: RESERVE_OUT,
    })) as Record<string, unknown> | null;
  } catch {
    console.error("study-ask: ai_begin2 failed");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }

  if (!begun || begun.ok !== true) {
    /* Every refusal Postgres knows about (off, unavailable, owner_only, no_model, monthly_cap,
       daily_cap, feature_cap, bad_install, device_cap, slow_down, rejected) passes through. */
    const error = begun && typeof begun.error === "string" && begun.error ? begun.error : "grader_error";
    return reply({ ok: false, error }, 200, origin);
  }

  const callId = begun.call_id;
  if (typeof callId !== "number" && typeof callId !== "string") {
    /* A row that cannot be closed must not be spent against. */
    console.error("study-ask: ai_begin2 returned no call id");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
  const model = typeof begun.model === "string" && begun.model ? begun.model : DEFAULT_MODEL;

  /* Effort: how much room and care this answer gets. The student picks it, or leaves it on auto
     and a small model reads the question. Auto runs here rather than in the page, so the cost
     lands in the ledger and one place decides. A classifier that is slow or unsure costs the
     question nothing: the default stands. */
  const levels = EFFORTS as Record<string, { words: number; max_tokens: number; think: boolean; bullets: string }>;
  const byIntent = INTENT_EFFORT as Record<string, string>;
  body.level = levels[body.effort] ? body.effort : DEFAULT_EFFORT;
  if (body.effort === "auto") {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1200);
      const r = await client.messages.create({
        model: INTENT_MODEL,
        max_tokens: 6,
        system: INTENT_SYSTEM,
        messages: [{ role: "user", content: body.question }],
      }, { signal: ctl.signal });
      clearTimeout(timer);
      const first = r.content.find((c) => c.type === "text") as { text?: string } | undefined;
      const intent = String(first?.text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
      if (byIntent[intent]) {
        body.intent = intent;
        body.level = byIntent[intent];
      }
    } catch {
      console.error("study-ask: the intent call did not answer in time");
    }
  }
  /* Whether an answer may go past the material is the owner's switch, read here from ai_begin2
     and never from the request: a forged body cannot turn it on. */
  body.beyond = begun.beyond === true;

  /* Textbook passages: the owner's own copy of their course book (0013), so ai_begin2 says
     whether this caller may draw on it. The page's own textbook flag only asks; it never grants,
     and a pass holder never gets one. They go after the material's own passages, so the numbers
     the client already holds stay valid, and their labels travel back in the done event. */
  body.textbookLabels = [];
  const corpus = CORPUS[body.material];
  if (body.textbook && begun.textbook === true && corpus) {
    try {
      const found = (await rpc("ai_passages_search", {
        p_corpus: corpus,
        p_query: (body.question + " " + body.quote).slice(0, 1000),
        p_chapter: body.chapter,
        p_limit: TEXTBOOK_PASSAGES,
      })) as { ok?: boolean; passages?: Array<{ chapter?: number; heading?: string; body?: string }> } | null;
      for (const p of (found && found.ok && Array.isArray(found.passages)) ? found.passages : []) {
        if (!p || typeof p.body !== "string" || !p.body) continue;
        if (body.chunks.length >= 14) break;
        const label = ("Textbook, chapter " + (p.chapter ?? "") + (p.heading ? ", " + p.heading : "")).slice(0, 80);
        body.chunks.push({ label, text: p.body.slice(0, TEXTBOOK_CHARS) });
        body.textbookLabels.push(label);
      }
    } catch {
      console.error("study-ask: textbook search failed");
    }
  }

  return streamAnswer(body, callId, model, origin);
});
