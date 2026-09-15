/* saq-grade: grades one APUSH short answer question with the Claude API.
 *
 * Deno, deployed as a Supabase Edge Function. The only caller is the material
 * study/src/m/apush/period1-2-test.html, and only when the owner has turned AI grading on.
 *
 * What this file is responsible for:
 *   validating the request before it costs anything,
 *   asking Postgres for permission and a budget (ai_begin),
 *   making exactly one Claude call with the prompt in grader_prompt.mjs,
 *   closing the ledger row exactly once (ai_end), whatever happened,
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
import Anthropic from "npm:@anthropic-ai/sdk";
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

/* One Claude call, 25 seconds. maxRetries is 1 rather than the SDK default of 2 so the
   worst case stays inside the function's own wall clock. */
const CALL_TIMEOUT_MS = 25_000;
const CALL_MAX_RETRIES = 1;

/* Clip the model's two feedback lines. The prompt asks for 240; this is the backstop. */
const FEEDBACK_MAX = 300;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

/* ---------------------------------------------------------------- small helpers */

type Json = Record<string, unknown>;

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
  };
}

/* ---------------------------------------------------------------- the model's answer */

type Part = { earned: boolean; why: string; fix: string; tea: { t: boolean; e: boolean; a: boolean } };

function line(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, FEEDBACK_MAX) : "";
}

/* Structured outputs put the object in parsed_output. The JSON schema is passed raw rather
   than through the zod helper, so nothing validates the shape for us: do it here, and fall
   back to the text block if a future SDK stops filling parsed_output for raw schemas. */
function readGrade(msg: { parsed_output?: unknown; content?: unknown }): Part[] | null {
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
  if (!obj || typeof obj !== "object") return null;
  const parts = (obj as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length !== 3) return null;

  const out: Part[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") return null;
    const q = p as Record<string, unknown>;
    const tea = (q.tea ?? {}) as Record<string, unknown>;
    if (typeof q.earned !== "boolean") return null;
    out.push({
      earned: q.earned,
      why: line(q.why),
      fix: line(q.fix),
      tea: { t: tea.t === true, e: tea.e === true, a: tea.a === true },
    });
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
       device_cap, slow_down) comes back to the client exactly as the database wrote it. */
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

  try {
    const total = body.answers.join("").length;
    if (total > maxChars) {
      /* endStatus stays 'error' with zero tokens, so the finally below closes the pending
         row and the reserve it holds is released. */
      return reply({ ok: false, error: "too_long", max_chars: maxChars }, 200, origin);
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const params = modelParams(model, effort) as Record<string, unknown>;
    const outputConfig = {
      ...((params.output_config as Record<string, unknown>) ?? {}),
      format: { type: "json_schema", schema: GRADE_SCHEMA_JSON },
    };

    let msg;
    try {
      msg = await client.messages.parse(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: systemPrompt(),
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
        } as never,
        { timeout: CALL_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES },
      );
    } catch (e) {
      /* Most specific first, and APIConnectionError before APIError: in the TypeScript SDK
         it is a subclass. Nothing from the error body is forwarded; the client only ever
         learns that the grader did not answer. */
      let kind = "unknown";
      if (e instanceof Anthropic.RateLimitError) kind = "rate_limit";
      else if (e instanceof Anthropic.APIConnectionError) kind = "connection";
      else if (e instanceof Anthropic.APIError) kind = `api_${e.status ?? 0}`;
      console.error(`saq-grade: call failed (${kind})`);
      return reply({ ok: false, error: "grader_error" }, 200, origin);
    }

    inTok = msg.usage?.input_tokens ?? 0;
    outTok = msg.usage?.output_tokens ?? 0;

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
    return reply({ ok: true, parts, model, cost_cents: costCents(model, inTok, outTok) }, 200, origin);
  } catch (e) {
    console.error("saq-grade: unexpected failure", e instanceof Error ? e.message : "unknown");
    return reply({ ok: false, error: "grader_error" }, 200, origin);
  } finally {
    /* Exactly once, on every path out of the try, including the early returns above. A
       pending row left open would hold its reserve against the monthly ceiling forever. */
    if (callId !== null && !ended) {
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
