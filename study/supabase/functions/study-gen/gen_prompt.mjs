/* study-gen: the prompt, the reply schema and the checks every generated question must pass.
 * Plain JavaScript with no imports, so node can test it (test_gen.mjs) and Deno can serve it.
 *
 * A generated question is kept only when all of this holds, checked in code, never by a model:
 *   four options, all different, none empty, none "all of the above" or "none of the above";
 *   one key (0 to 3);
 *   a misconception code on every wrong option and none on the key, from the material's own list;
 *   the words it cites found, in order, in the grounding text it was given (so it cannot cite a
 *     page it did not read);
 *   no em or en dash anywhere;
 *   not a copy of a question already in the bank (a word overlap of 0.6 or more);
 *   never about what a Key Term means (those are the student's own graded definitions).
 * No em dashes and no en dashes in this file. */

export const MAX_TOKENS = 3000;
export const MAX_ITEMS = 4;

/* The codes APUSH daily already tags every wrong option with (study/src/tools/daily/README.md). */
export const CODES = ['ce', 'time', 'rev', 'part', 'link', 'never', 'xt'];
const MIX_RE = /^mix:[a-z0-9-]{2,40}\|[a-z0-9-]{2,40}$/;

export const PRICES = {
  'claude-sonnet-5':   { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-5':     { in: 5, out: 25 },
  'claude-opus-5-5':   { in: 5, out: 25 },
  'claude-haiku-4-5':  { in: 1, out: 5 }
};

const OPT = { type: 'string' };
export const GEN_SCHEMA_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'o', 'a', 'why', 'mis', 'x', 'quote', 'page'],
        properties: {
          q: { type: 'string' },
          o: { type: 'array', items: OPT },
          a: { type: 'integer', enum: [0, 1, 2, 3] },
          why: { type: 'string' },
          mis: { type: 'array', items: { type: 'string' } },
          x: { type: 'boolean' },
          quote: { type: 'string' },
          page: { type: 'string' }
        }
      }
    }
  }
};

export function systemPrompt() {
  return [
    'You write multiple choice practice questions for a high school AP US History student, in the style of their teacher\'s chapter reading quiz.',
    'Write only from the GROUNDING text you are given. Never use anything you know that it does not say. If it does not hold enough for a good question, write fewer.',
    'Each question: a stem, exactly four options, exactly one right answer (a is its index, 0 to 3). Options are about the same length; the right one is not always the longest. No "all of the above", no "none of the above", no trick wording.',
    'About a third are EXCEPT questions ("All of the following ... EXCEPT"), where three options are true from the text and the answer is the one that is not; set x true for those.',
    'mis: one code per option, in option order. The right option gets "". Every wrong option gets the mistake a student who picks it is making, one of: ce (cause and effect reversed or wrong), time (wrong period or order), rev (the text says the opposite), part (true of only part of what is asked), link (true, but not what the question asks), never (not in the text at all), xt (on an EXCEPT question, a true statement picked as the false one).',
    'why: one or two sentences that say why the answer is right, in plain words, from the text.',
    'quote: 5 to 15 words copied exactly, in order, from the GROUNDING text, that support the answer. page: the page or heading the GROUNDING line gives for it.',
    'Never write a question that asks what a Key Term means or asks for its definition: those definitions are the student\'s own graded work.',
    'Never use an em dash or an en dash. Do not repeat a question from EXISTING.',
    'Reply only with the JSON object the schema describes.'
  ].join('\n');
}

export function userContent({ section, count, grounding, existing }) {
  return 'SECTION: ' + section + '\nWRITE: ' + count + ' questions\n\nGROUNDING:\n' + grounding
    + '\n\nEXISTING (do not repeat):\n' + (existing.length ? existing.map((s) => '- ' + s).join('\n') : '(none)');
}

const DASH = /[–—]/;
const norm = (s) => String(s || '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
export function overlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; A.forEach((w) => { if (B.has(w)) n++; });
  return n / Math.min(A.size, B.size);
}
const termNorm = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[’']s\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function asksForDefinition(q, terms) {
  const lq = ' ' + termNorm(q) + ' ';
  if (!/\b(define|definition|defined as|meaning of|what (is|was|were|are) (the |a |an )?|what does .* mean|best describes)\b/.test(lq)) return false;
  return terms.some((t) => t.length > 3 && lq.includes(' ' + t + ' ') && lq.replace(' ' + t + ' ', ' ').trim().split(' ').length <= 8);
}

/* One reply item to a stored item, or the reason it was dropped. */
export function checkItem(it, ctx) {
  if (!it || typeof it !== 'object') return { drop: 'shape' };
  const q = String(it.q || '').trim(), why = String(it.why || '').trim(), quote = String(it.quote || '').trim(), page = String(it.page || '').trim();
  const o = Array.isArray(it.o) ? it.o.map((x) => String(x || '').trim()) : [];
  const mis = Array.isArray(it.mis) ? it.mis.map((x) => String(x || '').trim()) : [];
  const a = Number(it.a);
  if (q.length < 12 || q.length > 600) return { drop: 'stem' };
  if (o.length !== 4 || o.some((x) => !x || x.length > 300)) return { drop: 'options' };
  if (new Set(o.map(norm)).size !== 4) return { drop: 'options repeat' };
  if (o.some((x) => /\b(all|none|both) of the (above|these)\b/i.test(x))) return { drop: 'all of the above' };
  if (!Number.isInteger(a) || a < 0 || a > 3) return { drop: 'key' };
  if (mis.length !== 4) return { drop: 'tags' };
  for (let i = 0; i < 4; i++) {
    if (i === a) { if (mis[i]) return { drop: 'tag on the key' }; continue; }
    if (!(CODES.includes(mis[i]) || MIX_RE.test(mis[i]))) return { drop: 'untagged wrong option' };
  }
  if (it.x === true && !/\bexcept\b/i.test(q)) return { drop: 'EXCEPT flag without EXCEPT' };
  if (!why || why.length > 800) return { drop: 'why' };
  if ([q, why, quote, page].concat(o).some((s) => DASH.test(s))) return { drop: 'dash' };
  const qw = norm(quote).split(' ').filter(Boolean);
  if (qw.length < 5 || qw.length > 20) return { drop: 'quote length' };
  if (norm(ctx.grounding).indexOf(norm(quote)) < 0) return { drop: 'quote not in the grounding' };
  if ((ctx.existing || []).some((s) => overlap(s, q) >= 0.6)) return { drop: 'copy of the bank' };
  if (asksForDefinition(q, (ctx.terms || []).map(termNorm))) return { drop: 'a Key Term definition' };
  return { item: { q, o, a, why, mis: mis.map((m, i) => (i === a ? null : m)), x: it.x === true, cite: { label: ctx.label || '', page: page.slice(0, 80), quote: quote.slice(0, 160) } } };
}

/* The whole reply: the kept items (at most count) and why each other one was dropped. */
export function checkReply(parsed, ctx) {
  const out = { items: [], dropped: [] };
  const list = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  const seen = [];
  for (const it of list) {
    const r = checkItem(it, Object.assign({}, ctx, { existing: (ctx.existing || []).concat(seen) }));
    if (r.item && out.items.length < Math.min(ctx.count || MAX_ITEMS, MAX_ITEMS)) { out.items.push(r.item); seen.push(r.item.q); }
    else out.dropped.push(r.drop || 'over the count');
  }
  return out;
}

export function costCents(model, inTok, outTok) {
  const p = PRICES[model] || PRICES['claude-sonnet-4-6'];
  return Math.round(((inTok * p.in + outTok * p.out) / 1e6) * 100 * 1000) / 1000;
}
