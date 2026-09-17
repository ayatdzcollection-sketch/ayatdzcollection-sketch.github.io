// Local check of the study-ask prompt module. No API call, no network. Run: node test_prompt.mjs
import assert from 'node:assert/strict';
import {
  FEATURE, MAX_TOKENS, RESERVE_IN, RESERVE_OUT, CHARS_PER_TOKEN, DEFAULT_MODEL, LIMITS, PRICES, THREAD_RE,
  PLAIN_MODELS, EFFORT_MODELS, modelParams, systemPrompt, buildRequest, estimateInputTokens, validateAsk
} from './ask_prompt.mjs';
import { PRICES as GRADER_PRICES } from '../saq-grade/grader_prompt.mjs';

const DASH = /[\u2014\u2013]/;

/* Constants and limits, as the function spec states them. */
assert.equal(FEATURE, 'ask');
assert.equal(MAX_TOKENS, 700);
assert.equal(RESERVE_IN, 8300);
assert.equal(RESERVE_OUT, 700);
assert.equal(CHARS_PER_TOKEN, 3.5);
assert.deepEqual(LIMITS, {
  body: 327680, material: 120, adminToken: 128, question: 600, quote: 1200, focus: 2500, map: 9000,
  chunks: 14, chunkLabel: 80, chunkText: 2000, chunksTotal: 16000, history: 6, historyText: 1500,
  progress: 3000, notes: 1500, turn: 100, chunkRef: 60, chapter: 12
});
assert.equal(String(THREAD_RE), String(/^[a-z0-9-]{8,64}$/));
assert.equal(PRICES, GRADER_PRICES, 'prices must come from the grader module');
for (const m of [...PLAIN_MODELS, ...EFFORT_MODELS, DEFAULT_MODEL]) assert.ok(PRICES[m] && PRICES[m].in > 0, 'no price for ' + m);

/* The system prompt. */
const sys = systemPrompt();
assert.equal(sys, systemPrompt(), 'the prompt must be byte stable or the cache never hits');
assert.ok(!DASH.test(sys), 'dash in system prompt');
for (const s of ['MATERIAL MAP', 'FOCUS', 'HIGHLIGHT', 'PASSAGES', 'QUESTION', 'On the test:', 'Sources: [1], [3]', '1491 to 1754', 'TEA', 'nothing outside it', '150 words', '**double asterisks**', 'yes or no', 'PROGRESS', 'NOTES', 'Remember:']) {
  assert.ok(sys.includes(s), 'system prompt is missing ' + s);
}
/* The PROGRESS, NOTES and Remember instructions close the prompt, word for word. */
const APPENDED = [
  "PROGRESS, when it is sent, is the student's own record in this material: the forecast, mock tests, weakest sections, questions they keep missing with the option they keep picking and the right answer, and short answer parts not earned. Use it only when the student asks about themselves (what to review, what they are weak at, a plan for tonight, why they keep missing something) or when the question is directly about something PROGRESS shows they keep getting wrong, and then say so in one short sentence. Recommend concretely from it: name the section, where in the material to do it (use the places PROGRESS names) and roughly how long. Rank weakness by how much of a section is held, lowest share first. Never invent progress that is not in PROGRESS, and never mention PROGRESS when the question has nothing to do with it.",
  'NOTES are things the student saved earlier. Follow a note that states a preference, such as how long answers should be, and keep a note about a difficulty in mind when it is relevant.',
  "Only when the QUESTION itself asks you to remember or note something (remember, note that, don't forget, keep in mind), confirm it in one short sentence, add one line that helps with it from the material, and end with one extra line after everything else, exactly: Remember: followed by one short sentence to save. Never write a Remember line in any other case."
].join('\n');
assert.ok(sys.includes('go back to helping with the material.\n\n' + APPENDED), 'the appended instructions are missing or reworded');
assert.ok(/Passages labelled Textbook/.test(sys) && /"Practice:"/.test(sys) && /never add Practice to two answers in a row/.test(sys), 'textbook and in chat material rules missing');

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

/* PROGRESS and NOTES come first, before FOCUS, trimmed. */
const withProgress = buildRequest({ model: 'claude-sonnet-4-6', ...full, progress: ' Forecast 3 of 7 ', notes: ' keep it short ' });
assert.equal(withProgress.messages[0].content, [
  'PROGRESS\nForecast 3 of 7',
  'NOTES\nkeep it short',
  'FOCUS\nCard 3 of 12',
  'HIGHLIGHT\nColumbian Exchange',
  'PASSAGES\n[1] Ch 1: One.\n\n[3] Three.',
  'QUESTION\nexplain'
].join('\n\n'));
assert.equal(buildRequest({ question: 'q', notes: 'n' }).messages[0].content, 'NOTES\nn\n\nQUESTION\nq');
assert.equal(buildRequest({ question: 'q', progress: 'p', notes: '   ' }).messages[0].content, 'PROGRESS\np\n\nQUESTION\nq');
/* The system prefix still does not depend on them, so the cache holds. */
assert.deepEqual(withProgress.system, r.system);

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
/* The reserve counts the progress and notes characters too. */
const withBoth = buildRequest({ model: 'claude-sonnet-4-6', ...full, progress: 'p'.repeat(3000), notes: 'n'.repeat(1500) });
const bothChars = withBoth.system.reduce((n, b) => n + b.text.length, 0) + withBoth.messages.reduce((n, m) => n + m.content.length, 0);
assert.equal(bothChars - chars, 3000 + 1500 + 'PROGRESS\n\n\n'.length + 'NOTES\n\n\n'.length);
assert.equal(estimateInputTokens(withBoth), Math.ceil(bothChars / 3.5));

/* Validation. */
const good = {
  material: 'apush/period1-2-test',
  install: '0123456789abcdef0123456789abcdef',
  adminToken: 'tok',
  question: '  explain  ',
  quote: 'q', focus: 'f', map: 'm',
  chunks: [{ label: 'l', text: 't' }],
  history: [{ role: 'user', text: 'u' }, { role: 'assistant', text: 'a' }],
  progress: ' p ', notes: ' n ', thread: 'thread-0a1b2c3d', turn: 2
};
const v = validateAsk(good);
assert.ok(v);
assert.equal(v.question, 'explain');
assert.equal(v.adminToken, 'tok');
assert.equal(v.progress, 'p');
assert.equal(v.notes, 'n');
assert.equal(v.thread, 'thread-0a1b2c3d');
assert.equal(v.turn, 2);
const minimal = validateAsk({ material: good.material, install: good.install, question: 'x' });
assert.deepEqual(minimal, {
  material: good.material, install: good.install, adminToken: null, question: 'x', quote: '', focus: '', map: '', chunks: [], history: [],
  progress: '', notes: '', thread: null, turn: 0, textbook: false, practice: true, widgets: true, chapter: null
});
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', chunks: [{ label: 'a', text: 'b', ref: 'q:abc_1' }] }).chunks[0].ref, 'q:abc_1');
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', chunks: [{ label: 'a', text: 'b', ref: 'bad ref' }] }), null);
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', textbook: 'yes' }), null);

const s = (n) => 'a'.repeat(n);
const at = (n, per) => Array.from({ length: n }, () => per);
const ok = [
  { question: s(600) }, { quote: s(1200) }, { focus: s(2500) }, { map: s(9000) }, { adminToken: s(128) },
  { chunks: at(14, { label: s(80), text: s(1142) }) }, { chunks: at(8, { text: s(2000) }) },
  { history: at(6, { role: 'user', text: s(1500) }) }, { question: '  ' + s(600) + '  ' }, { chunks: [{ text: '' }] },
  { progress: s(3000) }, { notes: s(1500) }, { progress: '' }, { notes: '  ' }, { progress: undefined }, { notes: undefined },
  { thread: s(8) }, { thread: s(64) }, { thread: '0-9-a-z-' }, { thread: undefined },
  { turn: 0 }, { turn: 100 }, { turn: undefined }
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
  { history: [{ role: 'user', text: s(1501) }] }, { history: [{ role: 'user' }] }, { history: [null] },
  { progress: s(3001) }, { progress: null }, { progress: 3 }, { notes: s(1501) }, { notes: null }, { notes: ['n'] },
  { thread: s(7) }, { thread: s(65) }, { thread: 'ABCDEFGH' }, { thread: 'abcd efgh' }, { thread: 'abcdefg_' }, { thread: '' },
  { thread: null }, { thread: 12345678 }, { thread: ' abcdefgh' },
  { turn: -1 }, { turn: 101 }, { turn: 1.5 }, { turn: '3' }, { turn: null }, { turn: NaN }, { turn: true }
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
  history: at(6, { role: 'user', text: s(1500) }),
  progress: s(3000), notes: s(1500), thread: s(64), turn: 100
};
assert.ok(validateAsk(biggest));
const jsonChars = JSON.stringify(biggest).length;
const letters = JSON.stringify(biggest).replace(/[{}[\]",:]/g, '').length;
assert.ok(jsonChars + 5 * letters <= LIMITS.body, 'body cap would refuse a valid request');
assert.ok(estimateInputTokens(buildRequest({ model: DEFAULT_MODEL, ...biggest })) < 60000);

/* Nothing the module produces carries an em or en dash. */
assert.ok(!DASH.test(JSON.stringify(buildRequest({ model: 'claude-opus-5', ...full, history: good.history, progress: 'p', notes: 'n' }))));

console.log('study-ask prompt module ok');
