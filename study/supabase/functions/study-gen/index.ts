/* study-gen: writes a few practice questions for one section of a material, with the Claude API.
 *
 * Deno, deployed as a Supabase Edge Function. The owner's decision of 2026-09-26 (CLAUDE.md, Paid
 * APIs, item 4; migration 0052). Owner only through the feature row 'gen' (mode owner, its own
 * daily cap, off by default), and only for a material tagged ai-gen.
 *
 * What this file is responsible for:
 *   validating the request before it costs anything;
 *   asking Postgres for permission and a budget (ai_begin2 with feature 'gen');
 *   adding the textbook's passages for the chapter when the material has a textbook corpus;
 *   making exactly one Claude call with the prompt in gen_prompt.mjs, answered as one JSON object;
 *   checking every question in code (gen_prompt.mjs, checkItem) and storing only the ones that pass
 *   (gen_insert), then closing the ledger row exactly once (ai_end), whatever happened;
 *   returning a small fixed set of error codes and never the API's own error text.
 *
 * What it never does: log, echo or return the API key; log or store the grounding text; keep a
 * question that failed a check; leave a pending ledger row open.
 *
 * Environment: ANTHROPIC_API_KEY (secret), SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (injected).
 * No em dashes and no en dashes in this file.
 */
import Anthropic, { RateLimitError, APIConnectionError, APIError } from "npm:@anthropic-ai/sdk";
import { GEN_SCHEMA_JSON, MAX_ITEMS, MAX_TOKENS, checkReply, costCents, systemPrompt, userContent } from "./gen_prompt.mjs";

const ALLOWED_ORIGINS = ["https://ayatdzcollection-sketch.github.io", "http://localhost:8000"];
const CALL_TIMEOUT_MS = 90_000;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

/* The private textbook corpus (migration 0013) per material and chapter, when one is loaded. */
const CORPUS: Record<string, Record<string, string>> = {
  "apush/daily": { c5: "fraser-5", c6: "fraser-6", c7: "fraser-7" },
};

type Json = Record<string, unknown>;

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
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
function clientIp(req: Request): string {
  const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
}
async function rpc(fn: string, body: Json): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`rpc ${fn} failed with ${res.status}`);
  return await res.json();
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/* ---------------------------------------------------------------- the request */
type Body = {
  material: string; install: string; adminToken: string;
  sec: string; ch: string; section: string; label: string; count: number;
  grounding: string; existing: string[]; terms: string[];
};
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
function validate(raw: unknown): Body | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (!isStr(b.material, 120) || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(b.material)) return null;
  if (!isStr(b.install, 64) || !/^[A-Za-z0-9_-]{8,64}$/.test(b.install)) return null;
  if (!isStr(b.adminToken, 127)) return null;
  if (!isStr(b.sec, 80) || !/^[a-z0-9.-]+$/.test(b.sec)) return null;
  if (!isStr(b.ch, 10) || !/^c\d{1,2}$/.test(b.ch)) return null;
  if (!isStr(b.section, 160) || !isStr(b.label, 120)) return null;
  const count = Number(b.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_ITEMS) return null;
  if (!isStr(b.grounding, 9000)) return null;
  const list = (v: unknown, n: number, m: number) => Array.isArray(v) && v.length <= n && v.every((x) => typeof x === "string" && x.length <= m);
  if (!list(b.existing, 60, 400) || !list(b.terms, 200, 120)) return null;
  return { material: b.material, install: b.install, adminToken: b.adminToken, sec: b.sec, ch: b.ch, section: b.section, label: b.label, count,
    grounding: b.grounding, existing: b.existing as string[], terms: b.terms as string[] };
}

/* ---------------------------------------------------------------- the handler */
Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "forbidden" }, 403, null);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "forbidden" }, 403, null);
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405, origin);
  let raw: unknown;
  try { raw = await req.json(); } catch { return reply({ ok: false, error: "bad_request" }, 400, origin); }
  const body = validate(raw);
  if (!body) return reply({ ok: false, error: "bad_request" }, 400, origin);
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("study-gen: a required environment variable is not set");
    return reply({ ok: false, error: "gen_error" }, 200, origin);
  }

  /* The textbook's passages for this section, when the chapter's corpus is loaded; the material's
     own text (sent by the page, from its own data) is always there. */
  let grounding = "FROM THE MATERIAL (" + body.label + "):\n" + body.grounding;
  const corpus = (CORPUS[body.material] || {})[body.ch];
  if (corpus) {
    try {
      const found = (await rpc("ai_passages_search", { p_corpus: corpus, p_query: body.section.slice(0, 300), p_chapter: Number(body.ch.slice(1)), p_limit: 4 })) as { ok?: boolean; passages?: Array<{ heading?: string; body?: string }> } | null;
      for (const p of found && found.ok && Array.isArray(found.passages) ? found.passages : []) {
        if (p && typeof p.body === "string" && p.body) grounding += "\n\nFROM THE TEXTBOOK (" + String(p.heading || "chapter " + body.ch.slice(1)).slice(0, 80) + "):\n" + p.body.slice(0, 1400);
      }
    } catch {
      console.error("study-gen: textbook search failed");
    }
  }
  grounding = grounding.slice(0, 14000);
  const content = userContent({ section: body.section, count: body.count, grounding, existing: body.existing });

  let begun: Record<string, unknown>;
  try {
    begun = (await rpc("ai_begin2", {
      p_feature: "gen", p_material: body.material, p_install: body.install, p_ip: clientIp(req), p_token: body.adminToken,
      p_in: Math.ceil((content.length + 2400) / 3.5), p_out: MAX_TOKENS,
    })) as Record<string, unknown>;
  } catch (e) {
    console.error("study-gen: ai_begin2 failed", e instanceof Error ? e.message : "unknown");
    return reply({ ok: false, error: "gen_error" }, 200, origin);
  }
  if (!begun || begun.ok !== true) return reply((begun ?? { ok: false, error: "gen_error" }) as Json, 200, origin);

  const callId = begun.call_id ?? null;
  const model = typeof begun.model === "string" && begun.model ? begun.model : "claude-sonnet-4-6";
  const started = Date.now();
  let endStatus = "error", inTok = 0, outTok = 0;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    let msg;
    try {
      msg = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        output_config: { format: { type: "json_schema", schema: GEN_SCHEMA_JSON } },
      } as never, { timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
    } catch (e) {
      let kind = "unknown";
      if (e instanceof RateLimitError) kind = "rate_limit";
      else if (e instanceof APIConnectionError) kind = "connection";
      else if (e instanceof APIError) kind = `api_${e.status ?? 0}`;
      console.error(`study-gen: call failed (${kind})`);
      return reply({ ok: false, error: "gen_error" }, 200, origin);
    }
    const u = (msg.usage ?? {}) as unknown as Record<string, number | null | undefined>;
    inTok = Math.ceil(num(u.input_tokens) + 1.25 * num(u.cache_creation_input_tokens) + 0.1 * num(u.cache_read_input_tokens));
    outTok = num(u.output_tokens);
    if (msg.stop_reason === "refusal") { endStatus = "refused"; return reply({ ok: false, error: "refused" }, 200, origin); }
    let parsed: unknown = null;
    try {
      const blocks = (Array.isArray(msg.content) ? msg.content : []) as unknown as Array<{ type?: string; text?: string }>;
      const text = blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
      parsed = JSON.parse(text);
    } catch {
      console.error("study-gen: the reply was not JSON");
      return reply({ ok: false, error: "gen_error" }, 200, origin);
    }
    const checked = checkReply(parsed, { grounding, existing: body.existing, terms: body.terms, count: body.count, label: body.label });
    endStatus = "ok";
    let ids: number[] = [];
    if (checked.items.length) {
      const put = (await rpc("gen_insert", { p_material: body.material, p_sec: body.sec, p_ch: body.ch, p_items: checked.items, p_call: callId })) as { ok?: boolean; ids?: number[] } | null;
      ids = put && put.ok && Array.isArray(put.ids) ? put.ids : [];
    }
    return reply({ ok: true, kept: ids.length, ids, dropped: checked.dropped, model, cost_cents: costCents(model, inTok, outTok) }, 200, origin);
  } catch (e) {
    console.error("study-gen: unexpected failure", e instanceof Error ? e.message : "unknown");
    return reply({ ok: false, error: "gen_error" }, 200, origin);
  } finally {
    if (callId !== null) {
      try {
        await rpc("ai_end", { p_call_id: callId, p_status: endStatus, p_in: inTok, p_out: outTok, p_latency: Date.now() - started });
      } catch (e) {
        console.error("study-gen: ai_end failed", e instanceof Error ? e.message : "unknown");
      }
    }
  }
});
