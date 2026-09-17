// Local check of the study-ask prompt module. No API call, no network. Run: node test_prompt.mjs
import assert from 'node:assert/strict';
import {
  FEATURE, MAX_TOKENS, RESERVE_IN, RESERVE_OUT, CHARS_PER_TOKEN, DEFAULT_MODEL, LIMITS, PRICES,
  PLAIN_MODELS, EFFORT_MODELS, modelParams, systemPrompt, buildRequest, estimateInputTokens, validateAsk
} from './ask_prompt.mjs';
import { PRICES as GRADER_PRICES } from '../saq-grade/grader_prompt.mjs';

const DASH = /[\u2014\u2013]/;

/* Constants and limits, as the function spec states them. */
assert.equal(FEATURE, 'ask');
assert.equal(MAX_TOKENS, 700);
assert.equal(RESERVE_IN, 7000);
assert.equal(RESERVE_OUT, 700);
assert.equal(CHARS_PER_TOKEN, 3.5);
assert.deepEqual(LIMITS, {
  body: 262144, material: 120, adminToken: 128, question: 600, quote: 1200, focus: 2500, map: 9000,
  chunks: 14, chunkLabel: 80, chunkText: 2000, chunksTotal: 16000, history: 6, historyText: 1500
});
assert.equal(PRICES, GRADER_PRICES, 'prices must come from the grader module');
for (const m of [...PLAIN_MODELS, ...EFFORT_MODELS, DEFAULT_MODEL]) assert.ok(PRICES[m] && PRICES[m].in > 0, 'no price for ' + m);

/* The system prompt. */
const sys = systemPrompt();
assert.equal(sys, systemPrompt(), 'the prompt must be byte stable or the cache never hits');
assert.ok(!DASH.test(sys), 'dash in system prompt');
for (const s of ['MATERIAL MAP', 'FOCUS', 'HIGHLIGHT', 'PASSAGES', 'QUESTION', 'On the test:', 'Sources: [1], [3]', '1491 to 1754', 'TEA', 'nothing outside it', '150 words', '**double asterisks**', 'yes or no']) {
  assert.ok(sys.includes(s), 'system prompt is missing ' + s);
}

/* Model params: no thinking anywhere; effort low only on the effort models. */
for (const m of PLAIN_MODELS) assert.deepEqual(modelParams(m), {}, m);
for (const m of EFFORT_MODELS) assert.deepEqual(modelParams(m), { output_config: { effort: 'low' } }, m);
assert.deepEqual(modelParams('claude-some-future-model'), { output_config: { effort: 'low' } });

const full = {
  map: '  Unit outline  ',
  question: '  explain  ',
  quote: ' Columbian Exchange ',
  focus: ' Card 3 of 12 ',
  chunks: [{ label: 'Ch 1', text: 'One.' }, { label: 'x', text: '   ' }, { label: '', text: 'Three.' }],
  history: []
};

/* Sonnet 4.6: no thinking parameter, no output_config, max_tokens 700, cache on the map block. */
let r = buildRequest({ model: 'claude-sonnet-4-6', ...full });
assert.deepEqual(Object.keys(r).sort(), ['max_tokens', 'messages', 'system']);
assert.equal(r.max_tokens, 700);
assert.ok(!('thinking' in r) && !('output_config' in r));
assert.equal(r.system.length, 2);
assert.equal(r.system[0].text, sys);
assert.equal(r.system[0].cache_control, undefined);
assert.equal(r.system[1].text, 'MATERIAL MAP\nUnit outline');
assert.deepEqual(r.system[1].cache_control, { type: 'ephemeral' });
assert.ok(!('thinking' in buildRequest({ model: 'claude-haiku-4-5', ...full })));

/* Adaptive models get effort low and still no thinking parameter. */
const o = buildRequest({ model: 'claude-opus-5', ...full });
assert.deepEqual(o.output_config, { effort: 'low' });
assert.ok(!('thinking' in o));

/* No map (or only whitespace): one system block, and it carries the breakpoint. */
for (const map of ['', '   ', undefined]) {
  const n = buildRequest({ model: 'claude-sonnet-4-6', ...full, map });
  assert.equal(n.system.length, 1);
  assert.deepEqual(n.system[0].cache_control, { type: 'ephemeral' });
}

/* The system prefix does not depend on the question, so it caches across questions. */
assert.deepEqual(buildRequest({ ...full, question: 'a' }).system, buildRequest({ ...full, question: 'b' }).system);

/* Block order and numbering. */
assert.equal(r.messages.length, 1);
assert.equal(r.messages[0].role, 'user');
const text = r.messages[0].content;
assert.equal(text, [
  'FOCUS\nCard 3 of 12',
  'HIGHLIGHT\nColumbian Exchange',
  'PASSAGES\n[1] Ch 1: One.\n\n[3] Three.',
  'QUESTION\nexplain'
].join('\n\n'));

/* Empty blocks are left out; QUESTION is always there. */
const bare = buildRequest({ model: 'claude-sonnet-4-6', question: 'huh' });
assert.equal(bare.messages[0].content, 'QUESTION\nhuh');
const onlyQuote = buildRequest({ question: 'what', quote: 'x', chunks: [{ label: 'a', text: ' ' }] }).messages[0].content;
assert.equal(onlyQuote, 'HIGHLIGHT\nx\n\nQUESTION\nwhat');

/* History: leading assistant turns dropped, empty turns dropped, runs merged, alternation kept,
   and a trailing user turn merged into the final question. */
const h = buildRequest({
  model: 'claude-sonnet-4-6',
  question: 'simpler',
  history: [
    { role: 'assistant', text: 'welcome' },
    { role: 'assistant', text: 'still me' },
    { role: 'user', text: ' q1 ' },
    { role: 'user', text: 'q1 again' },
    { role: 'assistant', text: '   ' },
    { role: 'assistant', text: 'a1' },
    { role: 'user', text: 'q2 unanswered' }
  ]
}).messages;
assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'user']);
assert.equal(h[0].content, 'q1\n\nq1 again');
assert.equal(h[1].content, 'a1');
assert.equal(h[2].content, 'q2 unanswered\n\nQUESTION\nsimpler');
for (let i = 1; i < h.length; i++) assert.notEqual(h[i].role, h[i - 1].role);
assert.deepEqual(buildRequest({ question: 'x', history: [{ role: 'assistant', text: 'only' }] }).messages.map((m) => m.role), ['user']);

/* The estimate. */
const est = estimateInputTokens(r);
const chars = r.system.reduce((n, b) => n + b.text.length, 0) + r.messages.reduce((n, m) => n + m.content.length, 0);
assert.equal(est, Math.ceil(chars / 3.5));
assert.equal(estimateInputTokens(null), RESERVE_IN);

/* Validation. */
const good = {
  material: 'apush/period1-2-test',
  install: '0123456789abcdef0123456789abcdef',
  adminToken: 'tok',
  question: '  explain  ',
  quote: 'q', focus: 'f', map: 'm',
  chunks: [{ label: 'l', text: 't' }],
  history: [{ role: 'user', text: 'u' }, { role: 'assistant', text: 'a' }]
};
const v = validateAsk(good);
assert.ok(v);
assert.equal(v.question, 'explain');
assert.equal(v.adminToken, 'tok');
const minimal = validateAsk({ material: good.material, install: good.install, question: 'x' });
assert.deepEqual(minimal, { material: good.material, install: good.install, adminToken: null, question: 'x', quote: '', focus: '', map: '', chunks: [], history: [] });

const s = (n) => 'a'.repeat(n);
const at = (n, per) => Array.from({ length: n }, () => per);
const ok = [
  { question: s(600) }, { quote: s(1200) }, { focus: s(2500) }, { map: s(9000) }, { adminToken: s(128) },
  { chunks: at(14, { label: s(80), text: s(1142) }) }, { chunks: at(8, { text: s(2000) }) },
  { history: at(6, { role: 'user', text: s(1500) }) }, { question: '  ' + s(600) + '  ' }, { chunks: [{ text: '' }] }
];
for (const patch of ok) assert.ok(validateAsk({ ...good, ...patch }), 'should pass: ' + Object.keys(patch));

const bad = [
  null, [], 'x', 1,
  { material: 'apush' }, { material: 'Apush/p1' }, { material: 'apush/p1/x' }, { material: 3 }, { material: 'a/' + s(119) },
  { install: 'abc' }, { install: '0123456789ABCDEF0123456789ABCDEF' }, { install: undefined },
  { adminToken: s(129) }, { adminToken: 5 }, { adminToken: null },
  { question: '' }, { question: '   ' }, { question: s(601) }, { question: undefined }, { question: 7 },
  { quote: s(1201) }, { quote: null }, { focus: s(2501) }, { focus: {} }, { map: s(9001) }, { map: [] },
  { chunks: {} }, { chunks: at(15, { text: 'x' }) }, { chunks: [null] }, { chunks: [['x']] },
  { chunks: [{ label: s(81), text: 'x' }] }, { chunks: [{ label: 'l', text: s(2001) }] }, { chunks: [{ label: 'l' }] },
  { chunks: at(9, { text: s(2000) }) },
  { history: {} }, { history: at(7, { role: 'user', text: 'x' }) }, { history: [{ role: 'system', text: 'x' }] },
  { history: [{ role: 'user', text: s(1501) }] }, { history: [{ role: 'user' }] }, { history: [null] }
];
for (const patch of bad) {
  const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...good, ...patch } : patch;
  assert.equal(validateAsk(body), null, 'should fail: ' + JSON.stringify(patch).slice(0, 60));
}

/* The largest valid request still fits the body cap with every character escaped, and its
   reserve stays under the 60000 token ceiling ai_begin2 clips to. */
const biggest = {
  ...good, adminToken: s(128), question: s(600), quote: s(1200), focus: s(2500), map: s(9000),
  chunks: [...at(8, { label: s(80), text: s(2000) }), ...at(6, { label: s(80), text: '' })],
  history: at(6, { role: 'user', text: s(1500) })
};
assert.ok(validateAsk(biggest));
const jsonChars = JSON.stringify(biggest).length;
const letters = JSON.stringify(biggest).replace(/[{}[\]",:]/g, '').length;
assert.ok(jsonChars + 5 * letters <= LIMITS.body, 'body cap would refuse a valid request');
assert.ok(estimateInputTokens(buildRequest({ model: DEFAULT_MODEL, ...biggest })) < 60000);

/* Nothing the module produces carries an em or en dash. */
assert.ok(!DASH.test(JSON.stringify(buildRequest({ model: 'claude-opus-5', ...full, history: good.history }))));

console.log('study-ask prompt module ok');
