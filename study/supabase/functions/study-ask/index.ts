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
 *   and, for a request with purpose 'trap' (migration 0025), one short call that is not streamed
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
  formNumbers,
  RERANK_FEATURE,
  RERANK_MODEL,
  RERANK_MAX_TOKENS,
  buildRerankRequest,
  parseRerank,
  validateRerank,
  MODE_FEATURE,
  DEEP_FEATURE,
  DEEP_MAX_TOKENS,
  DEEP_LIMITS,
  RESEARCH_PASSAGES,
  RESEARCH_PER_SOURCE,
  LINK_FEATURE,
  validateLink,
} from "./ask_prompt.mjs";
import { LINK_LIMITS, checkUrl, checkType, extract, passages as linkPassages, linkLabel } from "./link_fetch.mjs";

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
  marks: boolean;
  rules: string;
  items: number;
  checkwork: boolean;
  suggestNotes: boolean;
  effort: string;
  level?: string;
  intent?: string;
  beyond?: boolean;
  /* Which feature row this call is actually billed to, so the chat log can say the same thing
     the ledger says instead of the constant "ask". */
  feature?: string;
  chapter: number | null;
  textbookLabels?: string[];
  correctionCount?: number;
  /* Which instructions the cached block carries. saq and hasFacts come from the material's own
     adapter; hasTextbook and form are worked out here from the material id alone, never from the
     owner's grant, so that turning the textbook off does not rewrite the cached prefix. */
  saq: boolean;
  hasFacts: boolean;
  hasTextbook?: boolean;
  form?: boolean;
  correction?: boolean;
  shelf?: boolean;
  /* Research mode: which body of sources this question is answered from, whether the material
     comes with it, and whether the student asked for the deep and dear version. */
  mode: string;
  deep: boolean;
  withMaterial: boolean;
  facts: string[];
  tools: string[];
  kinds: string;
  check: boolean;
  fault: string;
};

/* A request for a list, a set to copy out, or everything on a topic. Those answers are long by
   nature, and the 700 token answer was cutting them in half. */
const LIST_MAX_TOKENS = 1500;

/* A pasted set of questions, answered one by one. The ceiling is the careful level's own, so no
   request can buy more room than the most careful single answer already gets. */
const ITEMS_MAX_TOKENS = 2400;

/* Which private textbook corpus (migration 0013) a material may draw on. */
const CORPUS: Record<string, string> = {
  "apush/period1-2-test": "fraser-1-4",
  "apush/fraser-ch1-2": "fraser-1-4",
  "apush/fraser-ch3-4": "fraser-1-4",
  "apush/fraser-review": "fraser-1-4",
  /* Fraser chapter 5 from the student's photos (load_ch5_sources.mjs), one chapter, cited by
     part and book page. */
  "apush/fraser-ch5": "fraser-5",
  /* The chemistry teacher's review form (migration 0029): one row per question with the key. */
  "chem/unit-measurement": "chem-unit-form",
};
const TEXTBOOK_PASSAGES = 3;
const TEXTBOOK_CHARS = 1000;

/* Corpora whose rows are numbered questions, fetched whole by number (formNumbers in
   ask_prompt.mjs) before any keyword search. */
const NUMBERED: Record<string, boolean> = { "chem-unit-form": true };

/* The source shelf (migration 0033 in the plan's section 5): the owner's own documents for a
   class, loaded into the same private passages table as the textbook under a corpus named after
   the class. No map and no deploy is needed to light one up: put rows under shelf-<class> and the
   materials of that class start drawing on them, and until then the search simply finds nothing. */
function shelfCorpus(material: string): string {
  const cls = material.split("/")[0] || "";
  return /^[a-z0-9-]{1,40}$/.test(cls) ? "shelf-" + cls : "";
}
const SHELF_PASSAGES = 3;
/* The label a private passage travels under: the row's own heading for the review form
   ("Review form, question 22"), and the textbook's chapter and heading for the APUSH book. */
function passageLabel(corpus: string, p: { chapter?: number; heading?: string }): string {
  if (NUMBERED[corpus]) return String(p.heading || "Review form").slice(0, 80);
  return ("Textbook, chapter " + (p.chapter ?? "") + (p.heading ? ", " + p.heading : "")).slice(0, 80);
}

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
          feature: body.feature || FEATURE,
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
          /* How this answer was reached and what it carried (migration 0032). The cache figures
             go in on their own as well as folded into input_tokens, because the cold question
             penalty cannot be measured from the blended number. */
          route: body.fault ? "escalated" : model.includes("haiku") ? "haiku" : "sonnet",
          retry: !!body.fault,
          chunks_sent: body.chunks.length,
          cache_read: num(usage.cache_read_input_tokens),
          cache_write: num(usage.cache_creation_input_tokens),
          marks: body.marks === true,
          has_rules: body.rules.length > 0,
          items: body.items,
          source_step: body.correctionCount ? "correction"
            : body.textbookLabels && body.textbookLabels.length ? "textbook" : "material",
          /* Which body of sources answered this one, so the owner can read research questions
             apart from ordinary ones without guessing from the labels (migration 0034). */
          mode: body.deep ? body.mode + "+deep" : body.mode,
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
      /* A pasted worksheet needs a line or two an item. The room is worked out here from what the
         student actually typed, not from a number the page sent, so a forged request cannot buy a
         longer answer than its own question asks for, and it never goes past the careful ceiling. */
      if (body.items >= 2) {
        const perItem = Math.min(body.items, Math.ceil(body.question.length / 40));
        request.max_tokens = Math.min(ITEMS_MAX_TOKENS, Math.max(Number(request.max_tokens) || 0, 400 + perItem * 180));
      }
      /* Deep research last, because it outranks both: it is the one thing the student is told the
         price of before they ask for it. */
      if (body.deep) request.max_tokens = Math.max(Number(request.max_tokens) || 0, DEEP_MAX_TOKENS);
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

/* The 'trap' feature (migration 0025), for a request with purpose 'trap': the same order as an
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

/* ---------------------------------------------------------------- pulling a link
   Research mode, external (migration 0034): the owner pastes the addresses they want an answer to
   come from, and this fetches one and stores it as passages under the corpus links-<install>.
   There is no model in this path at all, so a link costs nothing to add; what it costs is the
   tokens of whatever passages a later question uses. It is still behind its own feature row, so
   the owner can switch link pulling off without switching research mode off.

   This is not a search and not a crawler. It fetches the one address given, follows at most three
   redirects, and checks every hop against the same rules as the first, because an address that is
   safe and redirects to one that is not is the whole trick. */
async function pullLink(raw: unknown, req: Request, origin: string): Promise<Response> {
  const body = validateLink(raw) as { material: string; install: string; adminToken: string | null; url: string } | null;
  if (!body) return reply({ ok: false, error: "bad_request" }, 400, origin);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("study-ask: a required environment variable is not set");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
  const first = checkUrl(body.url) as { ok: boolean; url?: string; host?: string; error?: string };
  if (!first.ok) return reply({ ok: false, error: first.error }, 200, origin);

  /* The feature row is the switch and the owner check; it spends nothing, so it reserves nothing. */
  let begun: Record<string, unknown> | null;
  try {
    begun = (await rpc("ai_begin2", {
      p_feature: LINK_FEATURE,
      p_material: body.material,
      p_install: body.install,
      p_ip: clientIp(req),
      p_token: body.adminToken,
      p_in: 0,
      p_out: 0,
    })) as Record<string, unknown> | null;
  } catch {
    console.error("study-ask: ai_begin2 failed (link)");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
  if (!begun || begun.ok !== true) {
    const error = begun && typeof begun.error === "string" && begun.error ? begun.error : "grader_error";
    return reply({ ok: false, error }, 200, origin);
  }
  const callId = begun.call_id;
  const closeRow = async (status: EndStatus) => {
    if (typeof callId !== "number" && typeof callId !== "string") return;
    try {
      await rpc("ai_end", { p_call_id: callId, p_status: status, p_in: 0, p_out: 0, p_latency: 0 });
    } catch {
      console.error("study-ask: ai_end failed (link)");
    }
  };

  let url = first.url as string;
  let host = first.host as string;
  let html = "";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LINK_LIMITS.timeoutMs);
    try {
      for (let hop = 0; ; hop++) {
        const res = await fetch(url, {
          redirect: "manual",
          signal: ctl.signal,
          /* A plain, honest agent string. No cookies, no credentials, nothing of the student's. */
          headers: { "User-Agent": "StudyHubAsk/1.0 (+https://ayatdzcollection-sketch.github.io)", Accept: "text/html,text/plain;q=0.9" },
        });
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get("location");
          if (!next || hop >= LINK_LIMITS.redirects) { await closeRow("error"); return reply({ ok: false, error: "unreachable" }, 200, origin); }
          const hopUrl = checkUrl(new URL(next, url).toString()) as { ok: boolean; url?: string; host?: string; error?: string };
          if (!hopUrl.ok) { await closeRow("refused"); return reply({ ok: false, error: hopUrl.error }, 200, origin); }
          url = hopUrl.url as string;
          host = hopUrl.host as string;
          continue;
        }
        if (!res.ok) { await closeRow("error"); return reply({ ok: false, error: "unreachable" }, 200, origin); }
        const type = checkType(res.headers.get("content-type")) as { ok: boolean; error?: string };
        if (!type.ok) { await closeRow("refused"); return reply({ ok: false, error: type.error }, 200, origin); }
        const len = Number(res.headers.get("content-length") || 0);
        if (Number.isFinite(len) && len > LINK_LIMITS.bytes) { await closeRow("refused"); return reply({ ok: false, error: "too_big" }, 200, origin); }
        /* Read with a cap rather than trusting the header, which a server may not send. */
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > LINK_LIMITS.bytes) { await closeRow("refused"); return reply({ ok: false, error: "too_big" }, 200, origin); }
        html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* Nothing from the error reaches the caller or the log: it can carry the address back. */
    console.error("study-ask: a link did not answer");
    await closeRow("error");
    return reply({ ok: false, error: "unreachable" }, 200, origin);
  }

  const got = extract(html, { title: host }) as { title: string; text: string };
  const rows = linkPassages(got.text, { title: got.title }) as Array<{ heading: string; body: string }>;
  if (!rows.length) { await closeRow("ok"); return reply({ ok: false, error: "empty" }, 200, origin); }

  let saved: Record<string, unknown> | null = null;
  try {
    saved = (await rpc("ai_link_add", {
      p_install: body.install,
      p_url: url,
      p_host: host,
      p_title: got.title || host,
      p_bodies: rows.map((r) => r.body),
      /* The site name leads every heading, so a citation says where it came from and the per
         source cap in the question builder can tell two of the owner's pages apart. */
      p_headings: rows.map((r) => linkLabel(host, r.heading)),
    })) as Record<string, unknown> | null;
  } catch {
    console.error("study-ask: ai_link_add failed");
  }
  await closeRow("ok");
  if (!saved || saved.ok !== true) {
    const error = saved && typeof saved.error === "string" && saved.error ? saved.error : "grader_error";
    return reply({ ok: false, error }, 200, origin);
  }
  return reply({ ok: true, id: saved.id, n: saved.n, title: got.title || host, host, url }, 200, origin);
}

/* ---------------------------------------------------------------- the reranker
   Feature 'rerank' (migration 0033): the page's keyword scores came back weak, so one very small
   model reads the titles of the passages it was considering and says which of them bear on the
   question. Labels only, so the passage text is never sent here and never sent twice; the page
   holds it and builds the real question itself. About 0.07 cents, against roughly a cent for the
   tool round this replaces. Every refusal is a plain no, and the page simply keeps its own order:
   nothing here can make an answer fail. */
const RERANK_TIMEOUT_MS = 8_000;

async function rerankPick(raw: unknown, req: Request, origin: string): Promise<Response> {
  const body = validateRerank(raw) as
    { material: string; install: string; adminToken: string | null; question: string; labels: string[] } | null;
  if (!body) return reply({ ok: false, error: "bad_request" }, 400, origin);
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("study-ask: a required environment variable is not set");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }

  const request = buildRerankRequest(body) as Record<string, unknown>;
  let begun: Record<string, unknown> | null;
  try {
    begun = (await rpc("ai_begin2", {
      p_feature: RERANK_FEATURE,
      p_material: body.material,
      p_install: body.install,
      p_ip: clientIp(req),
      p_token: body.adminToken,
      p_in: estimateInputTokens(request),
      p_out: RERANK_MAX_TOKENS,
    })) as Record<string, unknown> | null;
  } catch {
    console.error("study-ask: ai_begin2 failed (rerank)");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
  if (!begun || begun.ok !== true) {
    /* off, plain_mode, paused, ceiling, the caps and the pass refusals all land here, and all of
       them mean the same thing to the page: carry on with your own order. */
    const error = begun && typeof begun.error === "string" && begun.error ? begun.error : "grader_error";
    return reply({ ok: false, error }, 200, origin);
  }
  const callId = begun.call_id;
  if (typeof callId !== "number" && typeof callId !== "string") {
    console.error("study-ask: ai_begin2 returned no call id (rerank)");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
  const model = typeof begun.model === "string" && begun.model ? begun.model : RERANK_MODEL;

  const started = Date.now();
  let status: EndStatus = "error";
  let usage: Usage = {};
  let pick: number[] = [];
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = (await client.messages.create(
      { model, ...request } as never,
      { timeout: RERANK_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES },
    )) as unknown as { content: Array<{ type: string; text?: string }>; usage?: Usage };
    if (msg.usage) usage = { ...msg.usage };
    const text = (msg.content || []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
    pick = parseRerank(text, body.labels.length);
    status = "ok";
  } catch (e) {
    status = "error";
    console.error("study-ask: rerank call failed (" + (e instanceof APIError ? "api_" + (e.status ?? 0) : "unknown") + ")");
  }

  const inTok = effectiveIn(usage);
  const outTok = num(usage.output_tokens);
  try {
    await rpc("ai_end", { p_call_id: callId, p_status: status, p_in: inTok, p_out: outTok, p_latency: Date.now() - started });
  } catch {
    console.error("study-ask: ai_end failed (rerank)");
  }
  if (status !== "ok") return reply({ ok: false, error: "grader_error" }, 200, origin);
  return reply({ ok: true, pick, model, cost_cents: costCents(model, inTok, outTok) }, 200, origin);
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

  /* A trap note (purpose 'trap', migration 0025) takes its own short path; an unknown purpose is
     refused like any other bad shape. */
  const purpose = purposeOf(raw);
  if (purpose === null) return reply({ ok: false, error: "bad_request" }, 400, origin);
  if (purpose === "trap") return await trapNote(raw, req, origin);
  if (purpose === "rerank") return await rerankPick(raw, req, origin);
  if (purpose === "link") return await pullLink(raw, req, origin);

  const body = validateAsk(raw) as AskBody | null;
  if (!body) return reply({ ok: false, error: "bad_request" }, 400, origin);

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    /* Not deployed fully. Say nothing about which piece is missing, and do not open a row. */
    console.error("study-ask: a required environment variable is not set");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }

  /* Which of the situational instruction paragraphs this material needs. Both are properties of the
     material, not of the question or of the owner's switches, so the cached instruction block stays
     byte identical for every question in this material and a follow up reads it at a tenth of the
     price. A material whose corpus is not listed in CORPUS simply never carries the textbook
     paragraph; it still answers correctly, it just is not told how to quote a textbook it has not
     got. */
  body.hasTextbook = !!CORPUS[body.material];
  body.form = !!NUMBERED[CORPUS[body.material] || ""];

  /* Research mode leaves the material out unless the student turned it back on. The page already
     sends no passages in that case; this is the same decision made again here, because what the
     answer is allowed to draw on is not a thing to take the page's word for. */
  const research = body.mode === "shelf" || body.mode === "links";
  if (research && !body.withMaterial) {
    body.chunks = [];
    body.map = "";
    body.progress = "";
    body.focus = "";
  }

  /* The reserve is sized from what is about to be sent. The model only changes request fields
     that carry no text, so the default stands in until ai_begin2 names the real one. Corrections
     and shelf passages are fetched further down and are not in this estimate; they are short, and
     ai_end records what was really billed. */
  const estimate = estimateInputTokens(buildRequest({ model: DEFAULT_MODEL, ...body }));

  /* Every kind of answer that costs more than the ordinary one is its own feature, so it has its
     own daily cap, the breaker can pause it on its own, and Plain mode refuses it outright. Deep
     research outranks the mode, because deep is what makes it dear. The page asks; the database
     decides.

     Named here rather than inline, because the chat log needs the same answer. It used to log the
     constant "ask" whatever the call really was, so the ledger and the chat list disagreed and
     every research, deep and retry answer was filed as an ordinary question. */
  const feature = body.deep ? DEEP_FEATURE
    : body.fault ? "retry"
    : (MODE_FEATURE as Record<string, string>)[body.mode] || FEATURE;
  body.feature = feature;

  let begun: Record<string, unknown> | null;
  try {
    begun = (await rpc("ai_begin2", {
      p_feature: feature,
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
  /* A pasted set is answered at normal, whatever the classifier made of it. Measured on one real
     four item worksheet: at quick the LENGTH line asked for 110 words to cover four questions and
     the whole answer got 298 tokens; at careful it got 944 tokens and cost 4.19 cents, because
     careful thinks and thinking rewrites the cached prefix every time. What a worksheet needs is
     room, which ITEMS_MAX_TOKENS gives it, not deliberation. Normal keeps the cache and the
     numbered answers both. */
  if (body.items >= 2) body.level = DEFAULT_EFFORT;

  /* Whether an answer may go past the material is the owner's switch, read here from ai_begin2
     and never from the request: a forged body cannot turn it on. Since 0036 ai_begin2 answers with
     the material contract, kept on the 'ask' row, rather than with whichever row was billed, so an
     attempt, its retry and its deep version are all held to the same rule.

     Research mode is settled here rather than there, because ai_begin2 is told the feature and not
     the mode, and deep is one feature whichever mode asked for it. A research answer is made of
     the sources the owner chose: LINKS_RULE and RESEARCH_ONLY already say so in as many words, and
     letting BEYOND_CORE in beside them would put a permission and a prohibition in one request. */
  body.beyond = research ? false : begun.beyond === true;

  /* Textbook passages: the owner's own copy of their course book (0013), so ai_begin2 says
     whether this caller may draw on it. The page's own textbook flag only asks; it never grants,
     and a pass holder never gets one. They go after the material's own passages, so the numbers
     the client already holds stay valid, and their labels travel back in the done event. */
  body.textbookLabels = [];
  const corpus = CORPUS[body.material];
  if (body.textbook && begun.textbook === true && corpus) {
    const seen = new Set<string>();
    /* A form question named by its number comes first, exactly, before the keyword search. */
    const asked = NUMBERED[corpus] ? formNumbers(body.question + " " + body.quote) : [];
    if (asked.length) {
      try {
        const got = (await rpc("ai_passages_get", { p_corpus: corpus, p_ords: asked })) as
          { ok?: boolean; passages?: Array<{ chapter?: number; heading?: string; body?: string }> } | null;
        for (const p of (got && got.ok && Array.isArray(got.passages)) ? got.passages : []) {
          if (!p || typeof p.body !== "string" || !p.body) continue;
          if (body.chunks.length >= 14) break;
          const label = passageLabel(corpus, p);
          if (seen.has(label)) continue;
          seen.add(label);
          body.chunks.push({ label, text: p.body.slice(0, TEXTBOOK_CHARS) });
          body.textbookLabels.push(label);
        }
      } catch {
        console.error("study-ask: form lookup failed");
      }
    }
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
        const label = passageLabel(corpus, p);
        if (seen.has(label)) continue;
        seen.add(label);
        body.chunks.push({ label, text: p.body.slice(0, TEXTBOOK_CHARS) });
        body.textbookLabels.push(label);
      }
    } catch {
      console.error("study-ask: textbook search failed");
    }
  }

  /* Corrections come first of everything, including the textbook: the owner wrote one precisely
     because an answer got this wrong before. They are cheap (three short rows at most) and they
     are the only thing here that can overrule the material. */
  try {
    const got = (await rpc("ai_corrections_get", {
      p_material: body.material,
      p_query: (body.question + " " + body.quote).slice(0, 2000),
      p_limit: 3,
    })) as { ok?: boolean; corrections?: Array<{ topic?: string; body?: string }> } | null;
    const rows = (got && got.ok && Array.isArray(got.corrections)) ? got.corrections : [];
    const ahead: Array<{ label: string; text: string }> = [];
    for (const c of rows) {
      if (!c || typeof c.body !== "string" || !c.body.trim()) continue;
      ahead.push({ label: ("Correction: " + (c.topic ?? "")).slice(0, 80), text: c.body.slice(0, 1000) });
    }
    if (ahead.length) {
      body.chunks = ahead.concat(body.chunks).slice(0, 14);
      body.correctionCount = ahead.length;
      /* The rule that says a Correction outranks the material rides with the question, not in the
         cached block, because whether one was found is a property of this question. */
      body.correction = true;
    }
  } catch {
    console.error("study-ask: corrections lookup failed");
  }

  /* The shelf, and in research mode whichever body of sources the mode names.
     In the ordinary mode the shelf is a second opinion behind the material, three passages, behind
     the same grant as the textbook. In research mode it IS the answer, so it gets eight, a cap of
     three from any one document so a long one cannot crowd out the rest, and, for the external
     mode, the owner's own fetched pages instead of the class shelf. */
  const CHUNK_CAP = body.deep ? DEEP_LIMITS.chunks : LIMITS.chunks;
  const corpusWanted = body.mode === "links" ? "links-" + body.install : shelfCorpus(body.material);
  /* The class shelf is the owner's to grant, the same as the textbook. A student's own saved links
     are their own, so the external mode does not wait on that grant. */
  const mayRead = body.mode === "links" || begun.textbook === true;
  if (corpusWanted && mayRead && body.chunks.length < CHUNK_CAP) {
    try {
      const found = (await rpc("ai_passages_search", {
        p_corpus: corpusWanted,
        p_query: (body.question + " " + body.quote).slice(0, 1000),
        p_chapter: null,
        p_limit: research ? RESEARCH_PASSAGES : SHELF_PASSAGES,
      })) as { ok?: boolean; passages?: Array<{ heading?: string; body?: string }> } | null;
      const perSource = new Map<string, number>();
      for (const p of (found && found.ok && Array.isArray(found.passages)) ? found.passages : []) {
        if (!p || typeof p.body !== "string" || !p.body) continue;
        if (body.chunks.length >= CHUNK_CAP) break;
        const heading = String(p.heading || (body.mode === "links" ? "A page you saved" : "Class notes"));
        /* Everything before the first colon is the document, which is how ai_link_add and
           load_passages.mjs both write a heading. */
        const source = heading.split(":")[0].trim().toLowerCase();
        const used = perSource.get(source) || 0;
        if (research && used >= RESEARCH_PER_SOURCE) continue;
        perSource.set(source, used + 1);
        const label = ("[" + heading + "]").slice(0, 80);
        body.chunks.push({ label, text: p.body.slice(0, body.deep ? DEEP_LIMITS.chunkText : TEXTBOOK_CHARS) });
        body.textbookLabels.push(label);
        /* As for a correction: the rule travels with the question that found a passage. */
        body.shelf = true;
      }
    } catch {
      console.error("study-ask: source search failed");
    }
  }
  /* A research question with no sources behind it is refused rather than answered from nothing:
     an empty research answer reads like an answer, and it is not one. The ledger row ai_begin2
     opened is closed here, because nothing past this point will do it. */
  if (research && !body.withMaterial && !body.chunks.length) {
    try {
      await rpc("ai_end", { p_call_id: callId, p_status: "refused", p_in: 0, p_out: 0, p_latency: 0 });
    } catch {
      console.error("study-ask: ai_end failed (no sources)");
    }
    return reply({ ok: false, error: "no_sources" }, 200, origin);
  }

  return streamAnswer(body, callId, model, origin);
});
