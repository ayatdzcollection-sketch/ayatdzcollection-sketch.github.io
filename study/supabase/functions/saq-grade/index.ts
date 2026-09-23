/* saq-grade: grades one APUSH short answer question with the Claude API.
 *
 * Deno, deployed as a Supabase Edge Function. The only caller is the material
 * study/src/m/apush/period1-2-test.html, and only when the owner has turned AI grading on.
 *
 * What this file is responsible for:
 *   validating the request before it costs anything,
 *   asking Postgres for permission and a budget (ai_begin),
 *   making exactly one Claude call with the prompt in grader_prompt.mjs, answered as one JSON
 *   reply, or, when the request carries stream: true, as Server Sent Events that carry the
 *   three verdicts as soon as the model has written them, then each part, then the whole grade,
 *   closing the ledger row exactly once (ai_end), whatever happened, including a client that
 *   disconnects halfway through a stream,
 *   returning a small fixed set of error codes and never the API's own error text.
 *
 * What it never does: log, echo or return the API key; log, store or forward the student's
 * answers or the prompt; leave a pending ledger row open.
 *
 * Environment:
 *   ANTHROPIC_API_KEY          Edge Function secret, set in the dashboard.
 *   SUPABASE_URL               injected by the platform.
 *   SUPABASE_SERVICE_ROLE_KEY  injected by the platform. ai_begin and ai_end are granted to
 *                              service_role only, so the anon key cannot reach them.
 *
 * Deploy, secrets and the smoke test: README.md beside this file.
 * No em dashes and no en dashes in this file.
 */
import Anthropic, { RateLimitError, APIConnectionError, APIError, APIUserAbortError } from "npm:@anthropic-ai/sdk";
import {
  CANDIDATE_MODELS,
  GRADE_SCHEMA_JSON,
  MAX_TOKENS,
  PRICES,
  modelParams,
  systemPrompt,
  userContent,
} from "./grader_prompt.mjs";

/* ---------------------------------------------------------------- configuration */

const ALLOWED_ORIGINS = [
  "https://ayatdzcollection-sketch.github.io",
  "http://localhost:8000",
];

/* One Claude call, one attempt. The SDK's own timeout only covers the wait for the response
   headers on a stream, so the streamed path also runs a wall clock timer of the same length
   that aborts a stream running past it. */
/* The fuller feedback takes longer to write, so one attempt gets a long leash rather than a
   short one that times out and quietly pays for a second try: a retry here cost 2.1 cents and
   66 seconds for one grade. */
const CALL_TIMEOUT_MS = 110_000;   /* the detailed feedback took 53 s once; a timeout still bills, so leave room */
const CALL_MAX_RETRIES = 0;

/* Clip the model's two feedback lines. The prompt asks for 240; this is the backstop. */
const FEEDBACK_MAX = 600;   /* why and fix now carry an explanation and a worked instruction */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

/* Supabase's runtime global. It keeps the worker alive for work that outlives the response,
   which is where ai_end runs when a client disconnects from a stream. Absent under plain Deno. */
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/* ---------------------------------------------------------------- small helpers */

type Json = Record<string, unknown>;

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

/* The ledger and the caps only ever see this, never a name and never any answer text. */
function clientIp(req: Request): string {
  /* The last entry is the hop the platform itself appended; the first is whatever the
     caller chose to send, so it never gates anything that costs money. */
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
}

/* max_chars from study_ai_settings, read with the service role (the table has RLS and no
   policies, so the anon key cannot read it). 6000 is the largest value the check constraint
   allows, so a failed read can only be more permissive than the row, never less. */
async function readMaxChars(): Promise<number> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/study_ai_settings?id=eq.1&select=max_chars`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, Accept: "application/json" },
    });
    if (!res.ok) return 6000;
    const rows = (await res.json()) as Array<{ max_chars?: unknown }>;
    const v = rows && rows[0] ? Number(rows[0].max_chars) : NaN;
    return Number.isFinite(v) && v >= 200 && v <= 6000 ? v : 6000;
  } catch {
    return 6000;
  }
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
       ai_begin include the visitor's address. */
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

/* ---------------------------------------------------------------- input validation */

const MATERIAL_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const INSTALL_RE = /^[0-9a-f]{32}$/;

function isStr(v: unknown, max: number, allowEmpty = false): boolean {
  return typeof v === "string" && v.length <= max && (allowEmpty || v.trim().length > 0);
}

function isTrio(v: unknown, max: number, allowEmpty = false): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((x) => isStr(x, max, allowEmpty));
}

type Body = {
  material: string;
  install: string;
  saqId: string;
  lead: string;
  parts: string[];
  rubric: string[];
  models: string[];
  stimText?: string;
  answers: string[];
  adminToken?: string;
  stream: boolean;
};

/* Everything is checked here, before a single row or token is spent. Anything that fails
   is a flat 400 with no detail: the client never sends these shapes by accident, so the
   only readers of a detailed message would be people probing the endpoint. */
function validate(raw: unknown): Body | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;

  if (!isStr(b.material, 80) || !MATERIAL_RE.test(b.material as string)) return null;
  if (typeof b.install !== "string" || !INSTALL_RE.test(b.install)) return null;
  if (!isStr(b.saqId, 63)) return null;
  if (!isStr(b.lead, 399)) return null;
  if (!isTrio(b.parts, 399)) return null;
  if (!isTrio(b.rubric, 799)) return null;
  if (!isTrio(b.models, 799)) return null;
  if (b.stimText !== undefined && !isStr(b.stimText, 3999, true)) return null;
  if (!isTrio(b.answers, 1199, true)) return null;
  if ((b.answers as string[]).join("").trim().length === 0) return null;
  if (b.adminToken !== undefined && !isStr(b.adminToken, 127)) return null;
  if (b.stream !== undefined && typeof b.stream !== "boolean") return null;

  return {
    material: b.material as string,
    install: b.install,
    saqId: b.saqId as string,
    lead: b.lead as string,
    parts: b.parts as string[],
    rubric: b.rubric as string[],
    models: b.models as string[],
    stimText: b.stimText as string | undefined,
    answers: b.answers as string[],
    adminToken: b.adminToken as string | undefined,
    stream: b.stream === true,
  };
}

/* ---------------------------------------------------------------- the model's answer */

type Part = { earned: boolean; teacher_earned: boolean; why: string; tea: { t: boolean; e: boolean; a: boolean }; tea_notes: { t: string; e: string; a: string }; accuracy: string; fix: string; rewrite: string; teacher: string };

type Verdict = { earned: boolean; teacher_earned: boolean };

function line(v: unknown, max = FEEDBACK_MAX): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/* One part, checked and clipped. The whole grade and each streamed part go through this, so a
   part looks the same whichever way it reaches the client. */
function readPart(p: unknown): Part | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const q = p as Record<string, unknown>;
  const tea = (q.tea ?? {}) as Record<string, unknown>;
  const notes = (q.tea_notes ?? {}) as Record<string, unknown>;
  if (typeof q.earned !== "boolean") return null;
  return {
    earned: q.earned,
    teacher_earned: q.teacher_earned === true,
    why: line(q.why),
    tea: { t: tea.t === true, e: tea.e === true, a: tea.a === true },
    tea_notes: { t: line(notes.t, 300), e: line(notes.e, 300), a: line(notes.a, 300) },
    accuracy: line(q.accuracy, 500),
    fix: line(q.fix),
    rewrite: line(q.rewrite, 800),
    /* The teacher line is for a rule that is broken. Asked to leave it empty otherwise, the model
       sometimes wrote "All of the teacher's rules are met" instead, which the page shows under
       YOUR TEACHER ALSO WANTS (seen 2026-09-22). */
    teacher: q.teacher_earned === true && /\b(all|every)\b[^.]*\b(met|followed|satisf)/i.test(line(q.teacher, 400)) ? "" : line(q.teacher, 400),
  };
}

/* The early verdicts: exactly three, each with both booleans, or nothing. They only ever
   decide what the student sees first; the parts decide the grade. */
function readVerdicts(v: unknown): Verdict[] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out: Verdict[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;
    const q = x as Record<string, unknown>;
    if (typeof q.earned !== "boolean" || typeof q.teacher_earned !== "boolean") return null;
    out.push({ earned: q.earned, teacher_earned: q.teacher_earned });
  }
  return out;
}

/* Structured outputs put the object in parsed_output. The JSON schema is passed raw rather
   than through the zod helper, so nothing validates the shape for us: do it here, and fall
   back to the text block if the SDK leaves parsed_output empty, which a stream always does
   for a raw schema.
   The parts are authoritative. Fewer than three is no grade; more than three (it happened once)
   keeps the first three, which are a, b and c. Where the verdicts disagree with the parts, the
   parts win. */
function gradeObject(msg: { parsed_output?: unknown; content?: unknown }): unknown {
  let obj: unknown = msg.parsed_output ?? null;
  if (obj === null || obj === undefined) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks.find((b: { type?: string }) => b && b.type === "text") as { text?: string } | undefined;
    if (!text || typeof text.text !== "string") return null;
    try {
      obj = JSON.parse(text.text);
    } catch {
      return null;
    }
  }
  return obj && typeof obj === "object" ? obj : null;
}

/* What the three parts show together (2026-09-22): the habit that cost the most and the one
   thing to do next time. Optional to the client: an older page simply never shows it, and a
   grade without it is still a grade. */
type Coach = { pattern: string; next: string };
function readCoach(msg: { parsed_output?: unknown; content?: unknown }): Coach | null {
  const obj = gradeObject(msg) as { coach?: unknown } | null;
  const c = obj && obj.coach && typeof obj.coach === "object" ? obj.coach as Record<string, unknown> : null;
  if (!c) return null;
  const coach = { pattern: line(c.pattern, 300), next: line(c.next, 240) };
  return coach.pattern || coach.next ? coach : null;
}

function readGrade(msg: { parsed_output?: unknown; content?: unknown }): Part[] | null {
  const obj = gradeObject(msg);
  if (!obj) return null;
  const parts = (obj as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length < 3) return null;
  if (parts.length > 3) console.error("saq-grade: the grade had more than three parts, the first three were used");

  const out: Part[] = [];
  for (const p of parts.slice(0, 3)) {
    const part = readPart(p);
    if (!part) return null;
    out.push(part);
  }

  const verdicts = readVerdicts((obj as { verdicts?: unknown }).verdicts);
  if (verdicts && verdicts.some((v, i) => v.earned !== out[i].earned || v.teacher_earned !== out[i].teacher_earned)) {
    console.error("saq-grade: the verdicts and the parts disagree, the parts were used");
  }
  return out;
}

function costCents(model: string, inTok: number, outTok: number): number {
  /* An unknown model is priced at the dearest candidate so the number shown can never be
     lower than what was actually billed. Postgres computes the ledger's own figure. */
  const price = (PRICES as Record<string, { in: number; out: number }>)[model] ?? { in: 5, out: 25 };
  const dollars = (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
  return Math.round(dollars * 100 * 1000) / 1000;
}

/* The request body for messages.parse and messages.stream alike. */
function gradeRequest(body: Body, model: string, effort: string): Record<string, unknown> {
  const params = modelParams(model, effort) as Record<string, unknown>;
  const outputConfig = {
    ...((params.output_config as Record<string, unknown>) ?? {}),
    format: { type: "json_schema", schema: GRADE_SCHEMA_JSON },
  };
  return {
    model,
    max_tokens: MAX_TOKENS,
    /* The system prompt is identical on every call and over Sonnet's 1024 token cache
       minimum, so a student grading several parts in a sitting pays a tenth of its
       input price after the first call. */
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: userContent({
          lead: body.lead,
          parts: body.parts,
          rubric: body.rubric,
          models: body.models,
          stimText: body.stimText,
          answers: body.answers,
        }),
      },
    ],
    ...params,
    output_config: outputConfig,
  };
}

/* ---------------------------------------------------------------- reading a grade as it streams */

type ScanHit = { kind: "verdicts"; value: unknown } | { kind: "part"; index: number; value: unknown };

type Frame = {
  open: "{" | "[";
  start: number;                                        /* offset of the bracket in the buffer */
  key: string | null;                                   /* objects: the last key read */
  expectKey: boolean;                                   /* objects: the next string is a key */
  count: number;                                        /* arrays: index of the element being read */
  role: "root" | "verdicts" | "parts" | "part" | null;
  index: number;                                        /* role part: its place in parts */
};

/* Reads the model's JSON text a chunk at a time and reports two things the moment they close:
   the verdicts array at the top level, and each object inside the top level parts array. It
   tracks only string and escape state and bracket depth, so a brace or a quote inside a
   feedback string never confuses it, and it parses nothing but the closed slices it reports.
   Anything after the top level object closes is ignored. */
class GradeScanner {
  private buf = "";
  private pos = 0;
  private stack: Frame[] = [];
  private inStr = false;
  private esc = false;
  private strStart = 0;
  private strIsKey = false;
  private finished = false;

  push(chunk: string): ScanHit[] {
    const hits: ScanHit[] = [];
    if (this.finished || !chunk) return hits;
    this.buf += chunk;
    for (; this.pos < this.buf.length; this.pos++) {
      const ch = this.buf[this.pos];
      const top = this.stack.length ? this.stack[this.stack.length - 1] : null;

      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (ch === "\\") this.esc = true;
        else if (ch === '"') {
          this.inStr = false;
          if (this.strIsKey && top) {
            try {
              const k = JSON.parse(this.buf.slice(this.strStart, this.pos + 1));
              top.key = typeof k === "string" ? k : null;
            } catch {
              top.key = null;
            }
          }
        }
        continue;
      }

      if (ch === '"') {
        this.inStr = true;
        this.strStart = this.pos;
        this.strIsKey = !!top && top.open === "{" && top.expectKey;
      } else if (ch === ":") {
        if (top && top.open === "{") top.expectKey = false;
      } else if (ch === ",") {
        if (top && top.open === "{") top.expectKey = true;
        else if (top) top.count++;
      } else if (ch === "{" || ch === "[") {
        let role: Frame["role"] = null;
        let index = -1;
        if (!top) {
          role = "root";
        } else if (top.role === "root" && top.open === "{" && !top.expectKey && ch === "[") {
          if (top.key === "verdicts") role = "verdicts";
          else if (top.key === "parts") role = "parts";
        } else if (top.role === "parts" && ch === "{") {
          role = "part";
          index = top.count;
        }
        this.stack.push({ open: ch, start: this.pos, key: null, expectKey: ch === "{", count: 0, role, index });
      } else if (ch === "}" || ch === "]") {
        const frame = this.stack.pop();
        if (!frame) continue;
        if (frame.role === "verdicts" || frame.role === "part") {
          try {
            const value = JSON.parse(this.buf.slice(frame.start, this.pos + 1));
            hits.push(frame.role === "verdicts" ? { kind: "verdicts", value } : { kind: "part", index: frame.index, value });
          } catch {
            /* not valid JSON after all: report nothing, the final parse decides */
          }
        }
        if (this.stack.length === 0) {
          this.finished = true;
          this.pos++;
          break;
        }
      }
    }
    return hits;
  }
}

/* ---------------------------------------------------------------- the stream */

const encoder = new TextEncoder();

/* Opens the SSE response for a call ai_begin has already let through. From the moment this is
   called it owns the ledger row: every path out of here, including a throw, a timeout, a refusal
   and the client going away, reaches finish(), and finish() calls ai_end at most once. It never
   throws. */
function streamGrade(body: Body, callId: unknown, model: string, effort: string, origin: string): Response {
  const started = Date.now();
  let status: EndStatus = "error";
  let usage: Usage = {};
  let ended = false;
  let closed = false;
  let cancelled = false;
  let timedOut = false;
  let live: { abort(): void } | null = null;

  const finish = async (): Promise<void> => {
    if (ended || callId === null) return;
    ended = true;
    try {
      await rpc("ai_end", {
        p_call_id: callId,
        p_status: status,
        p_in: effectiveIn(usage),
        p_out: num(usage.output_tokens),
        p_latency: Date.now() - started,
      });
    } catch (e) {
      console.error("saq-grade: ai_end failed", e instanceof Error ? e.message : "unknown");
    }
  };

  const run = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    /* True only when the event was handed to the response. */
    const send = (event: Json): boolean => {
      if (closed) return false;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        return true;
      } catch {
        closed = true;
        return false;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      if (cancelled) return;
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const stream = client.messages.stream(
        gradeRequest(body, model, effort) as never,
        { timeout: CALL_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES },
      );
      live = stream;
      timer = setTimeout(() => {
        timedOut = true;
        stream.abort();
      }, CALL_TIMEOUT_MS);
      /* The client may have gone between the check above and here. */
      if (cancelled) stream.abort();

      const scanner = new GradeScanner();
      const sentParts = new Set<number>();
      let sawVerdicts = false;

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
          for (const hit of scanner.push(ev.delta.text)) {
            if (hit.kind === "verdicts") {
              /* Only the first verdicts array counts, and only a clean one is shown. */
              if (sawVerdicts) continue;
              sawVerdicts = true;
              const verdicts = readVerdicts(hit.value);
              if (verdicts) send({ type: "verdicts", verdicts });
            } else if (hit.index >= 0 && hit.index <= 2 && !sentParts.has(hit.index)) {
              const part = readPart(hit.value);
              if (part) {
                sentParts.add(hit.index);
                send({ type: "part", index: hit.index, part });
              }
            }
          }
        }
      }

      const msg = await stream.finalMessage();
      clearTimeout(timer);
      timer = undefined;
      if (msg.usage) usage = { ...(msg.usage as Usage) };

      if (msg.stop_reason === "refusal") {
        /* Verdicts or parts may already have streamed. The client drops them on this event. */
        status = "refused";
        send({ type: "error", error: "refused" });
        return;
      }

      const parts = readGrade(msg as unknown as { parsed_output?: unknown; content?: unknown });
      if (!parts) {
        console.error("saq-grade: the model returned no usable grade");
        send({ type: "error", error: "grader_error" });
        return;
      }

      /* ok only when done actually went out; a client gone by now is recorded as error, with
         the tokens it cost all the same. */
      const coach = readCoach(msg as unknown as { parsed_output?: unknown; content?: unknown });
      const done = { type: "done", parts, ...(coach ? { coach } : {}), model, cost_cents: costCents(model, effectiveIn(usage), num(usage.output_tokens)) };
      status = send(done) ? "ok" : "error";
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
      console.error(`saq-grade: call failed (${kind})`);
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
    console.error("saq-grade: could not open the stream");
    cancelled = true;
    if (live) (live as { abort(): void }).abort();
    if (!work) keepAlive(finish());
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }
}

/* ---------------------------------------------------------------- the handler */

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "forbidden" }, 403, null);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  /* Only the two origins the hub is served from, and the header must be present: a call
     with no Origin (curl, a script) is refused too. The smoke test sends the header. */
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "forbidden" }, 403, null);
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405, origin);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return reply({ ok: false, error: "bad_request" }, 400, origin);
  }

  const body = validate(raw);
  if (!body) return reply({ ok: false, error: "bad_request" }, 400, origin);

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    /* Not deployed fully. Say nothing about which piece is missing, and do not open a row. */
    console.error("saq-grade: a required environment variable is not set");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }

  const ip = clientIp(req);

  let begun: Record<string, unknown>;
  /* Length gate before anything is written: an oversized answer never opens a ledger row.
     The cap is read from the settings row with the service role; if that read fails the
     hard ceiling of the settings' own range check (6000) applies and ai_begin still checks. */
  const preCap = await readMaxChars();
  if (body.answers.join("").length > preCap) return reply({ ok: false, error: "too_long", max_chars: preCap }, 200, origin);

  try {
    begun = (await rpc("ai_begin", {
      p_material: body.material,
      p_install: body.install,
      p_ip: ip,
      p_token: body.adminToken ?? null,
    })) as Record<string, unknown>;
  } catch (e) {
    console.error("saq-grade: ai_begin failed", e instanceof Error ? e.message : "unknown");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  }

  if (!begun || begun.ok !== true) {
    /* Every refusal Postgres knows about (off, owner_only, daily_cap, monthly_cap,
       device_cap, slow_down) comes back to the client exactly as the database wrote it.
       A stream request gets the same JSON: the stream only opens once a call is let through. */
    return reply((begun ?? { ok: false, error: "grader_error" }) as Json, 200, origin);
  }

  const callId = begun.call_id ?? null;
  const model = typeof begun.model === "string" && begun.model ? begun.model : CANDIDATE_MODELS[0];
  const effort = typeof begun.effort === "string" ? begun.effort : "low";
  const maxChars = Number.isFinite(begun.max_chars) ? Number(begun.max_chars) : 2000;

  const started = Date.now();
  let endStatus = "error";
  let inTok = 0;
  let outTok = 0;
  let ended = false;
  let handedOff = false;

  try {
    const total = body.answers.join("").length;
    if (total > maxChars) {
      /* endStatus stays 'error' with zero tokens, so the finally below closes the pending
         row and the reserve it holds is released. */
      return reply({ ok: false, error: "too_long", max_chars: maxChars }, 200, origin);
    }

    if (body.stream) {
      /* From here the stream owns the row and closes it exactly once; streamGrade never
         throws, so the finally below must leave the row alone. */
      handedOff = true;
      return streamGrade(body, callId, model, effort, origin);
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    /* create, not parse: parse runs JSON.parse on the text itself and throws on anything that is
       not whole JSON (a refusal, or an answer cut off at max_tokens), before the usage and the
       stop reason can be read, which recorded a billed call as 0 tokens and a refusal as
       grader_error. readGrade parses the text block and checks the shape. */
    let msg;
    try {
      msg = await client.messages.create(
        gradeRequest(body, model, effort) as never,
        { timeout: CALL_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES },
      );
    } catch (e) {
      /* Most specific first, and APIConnectionError before APIError: in the TypeScript SDK
         it is a subclass. Nothing from the error body is forwarded; the client only ever
         learns that the grader did not answer. */
      let kind = "unknown";
      if (e instanceof RateLimitError) kind = "rate_limit";
      else if (e instanceof APIConnectionError) kind = "connection";
      else if (e instanceof APIError) kind = `api_${e.status ?? 0}`;
      console.error(`saq-grade: call failed (${kind})`);
      return reply({ ok: false, error: "grader_error" }, 200, origin);
    }

    const u = (msg.usage ?? {}) as unknown as Usage;
    inTok = effectiveIn(u);
    outTok = num(u.output_tokens);

    if (msg.stop_reason === "refusal") {
      endStatus = "refused";
      return reply({ ok: false, error: "refused" }, 200, origin);
    }

    const parts = readGrade(msg as { parsed_output?: unknown; content?: unknown });
    if (!parts) {
      console.error("saq-grade: the model returned no usable grade");
      return reply({ ok: false, error: "grader_error" }, 200, origin);
    }

    endStatus = "ok";
    const coach = readCoach(msg as { parsed_output?: unknown; content?: unknown });
    return reply({ ok: true, parts, ...(coach ? { coach } : {}), model, cost_cents: costCents(model, inTok, outTok) }, 200, origin);
  } catch (e) {
    console.error("saq-grade: unexpected failure", e instanceof Error ? e.message : "unknown");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  } finally {
    /* Exactly once, on every path out of the try, including the early returns above. A
       pending row left open would hold its reserve against the monthly ceiling forever. */
    if (callId !== null && !ended && !handedOff) {
      ended = true;
      try {
        await rpc("ai_end", {
          p_call_id: callId,
          p_status: endStatus,
          p_in: inTok,
          p_out: outTok,
          p_latency: Date.now() - started,
        });
      } catch (e) {
        console.error("saq-grade: ai_end failed", e instanceof Error ? e.message : "unknown");
      }
    }
  }
});
