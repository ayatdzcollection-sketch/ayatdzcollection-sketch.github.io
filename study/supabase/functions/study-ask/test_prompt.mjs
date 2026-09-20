// Local check of the study-ask prompt module. No API call, no network. Run: node test_prompt.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FEATURE, MAX_TOKENS, RESERVE_IN, RESERVE_OUT, CHARS_PER_TOKEN, DEFAULT_MODEL, LIMITS, PRICES, THREAD_RE,
  PLAIN_MODELS, EFFORT_MODELS, LIST_RE, modelParams, systemPrompt, buildRequest, MATH_RULE, estimateInputTokens, validateAsk
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
  body: 655360, material: 120, adminToken: 128, question: 4000, quote: 1200, focus: 2500, map: 9000,
  chunks: 14, chunkLabel: 80, chunkText: 2000, chunksTotal: 16000, history: 12, historyText: 4000,
  progress: 3000, notes: 1500, turn: 100, chunkRef: 60, chapter: 12, facts: 6, fact: 300, kinds: 1500,
  rules: 600, items: 20, fault: 400
});
assert.equal(String(THREAD_RE), String(/^[a-z0-9-]{8,64}$/));
assert.equal(PRICES, GRADER_PRICES, 'prices must come from the grader module');
for (const m of [...PLAIN_MODELS, ...EFFORT_MODELS, DEFAULT_MODEL]) assert.ok(PRICES[m] && PRICES[m].in > 0, 'no price for ' + m);

/* The system prompt. */
const sys = systemPrompt();
assert.equal(sys, systemPrompt(), 'the prompt must be byte stable or the cache never hits');
assert.ok(!DASH.test(sys), 'dash in system prompt');
for (const s of ['MATERIAL MAP', 'FOCUS', 'HIGHLIGHT', 'PASSAGES', 'QUESTION', 'On the test:', 'Sources: [1], [3]', '1491 to 1754', 'TEA', 'nothing outside it', '**double asterisks**', 'yes or no', 'PROGRESS', 'NOTES', 'Remember:', 'LENGTH line']) {
  assert.ok(sys.includes(s), 'system prompt is missing ' + s);
}
/* The PROGRESS, NOTES and Remember instructions close the prompt, word for word. */
const APPENDED = [
  "PROGRESS, when it is sent, is the student's own record in this material: the forecast, mock tests, weakest sections, questions they keep missing with the option they keep picking and the right answer, and short answer parts not earned. Use it only when the student asks about themselves (what to review, what they are weak at, a plan for tonight, why they keep missing something) or when the question is directly about something PROGRESS shows they keep getting wrong, and then say so in one short sentence. Recommend concretely from it: name the section and where in the material to do it, using the places PROGRESS names. Do not say how long it will take: you do not know. Rank weakness by how much of a section is held, lowest share first. Never invent progress that is not in PROGRESS, and never mention PROGRESS when the question has nothing to do with it.",
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

/* Sonnet 4.6 at the default effort: no thinking parameter, no output_config, cache on the map
   block, and the room that level asks for. */
let r = buildRequest({ model: 'claude-sonnet-4-6', ...full });
assert.deepEqual(Object.keys(r).sort(), ['max_tokens', 'messages', 'system']);
assert.equal(r.max_tokens, 1000);
assert.ok(!('thinking' in r) && !('output_config' in r));
assert.equal(r.system.length, 2);
assert.equal(r.system[0].text, sys);
/* Two breakpoints: the instructions, then the map. */
assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
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
  'LENGTH\nAbout 200 words, and at most four bullet points.',
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
  'LENGTH\nAbout 200 words, and at most four bullet points.',
  'QUESTION\nexplain'
].join('\n\n'));
assert.equal(buildRequest({ question: 'q', notes: 'n' }).messages[0].content, 'NOTES\nn\n\nLENGTH\nAbout 200 words, and at most four bullet points.\n\nQUESTION\nq');
assert.equal(buildRequest({ question: 'q', progress: 'p', notes: '   ' }).messages[0].content, 'PROGRESS\np\n\nLENGTH\nAbout 200 words, and at most four bullet points.\n\nQUESTION\nq');
/* The system prefix still does not depend on them, so the cache holds. */
assert.deepEqual(withProgress.system, r.system);

/* Empty blocks are left out; QUESTION is always there. */
const bare = buildRequest({ model: 'claude-sonnet-4-6', question: 'huh' });
assert.equal(bare.messages[0].content, 'LENGTH\nAbout 200 words, and at most four bullet points.\n\nQUESTION\nhuh');
const onlyQuote = buildRequest({ question: 'what', quote: 'x', chunks: [{ label: 'a', text: ' ' }] }).messages[0].content;
assert.equal(onlyQuote, 'HIGHLIGHT\nx\n\nLENGTH\nAbout 200 words, and at most four bullet points.\n\nQUESTION\nwhat');

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
assert.equal(h[2].content, 'q2 unanswered\n\nLENGTH\nAbout 200 words, and at most four bullet points.\n\nQUESTION\nsimpler');
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
  progress: '', notes: '', thread: null, turn: 0, textbook: false, practice: true, widgets: true, math: false, marks: false, effort: 'normal', chapter: null,
  facts: [], tools: [], kinds: '', check: false, rules: '', items: 0, checkwork: false, suggestNotes: true, fault: ''
});
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', chunks: [{ label: 'a', text: 'b', ref: 'q:abc_1' }] }).chunks[0].ref, 'q:abc_1');
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', chunks: [{ label: 'a', text: 'b', ref: 'bad ref' }] }), null);
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', textbook: 'yes' }), null);
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', math: 'yes' }), null);
assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', math: true }).math, true);

/* Math: the paragraph goes only to pages that can draw it, and it rides in the cached system text. */
{
  const off = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q' });
  const on = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', math: true });
  assert.ok(!off.system[0].text.includes(MATH_RULE));
  assert.ok(on.system[0].text.includes(MATH_RULE));
  assert.ok(on.system[1].cache_control);
  assert.ok(!/[\u2014\u2013]/.test(MATH_RULE));
}

/* Effort: the same prompt with more or less room, and the level is what decides. */
{
  /* The care level must NOT reach the cached prompt. It used to, as the word and bullet counts,
     and one careful question between two normal ones rewrote the whole prefix for about 1.5
     cents; auto changes level from question to question, so that was happening constantly. */
  for (const e of ['quick', 'normal', 'careful', 'nonsense', undefined]) {
    assert.equal(systemPrompt({ effort: e }), sys, 'the level must not change the cached prompt: ' + e);
  }
  const lens = {};
  for (const e of ['quick', 'normal', 'careful']) {
    const r2 = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', effort: e });
    assert.deepEqual(r2.system, buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q' }).system, 'same prefix at ' + e);
    const m2 = r2.messages[0].content.match(/LENGTH\nAbout (\d+) words, and at most (\w+) bullet points\./);
    assert.ok(m2, 'the LENGTH line must ride in the message at ' + e);
    lens[e] = m2[1];
  }
  assert.deepEqual(lens, { quick: '110', normal: '200', careful: '350' });
  const r = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', effort: 'careful' });
  assert.equal(r.max_tokens, 2400, 'careful must have room to finish');
  assert.deepEqual(r.thinking, { type: 'adaptive' }, 'careful must think');
  assert.ok(!buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', effort: 'quick' }).thinking, 'quick must not think');
  assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', effort: 'auto' }).effort, 'auto');
  assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x', effort: 'huge' }), null);
  assert.equal(validateAsk({ material: good.material, install: good.install, question: 'x' }).effort, 'normal');
}

const s = (n) => 'a'.repeat(n);
const at = (n, per) => Array.from({ length: n }, () => per);
const ok = [
  { question: s(4000) }, { quote: s(1200) }, { focus: s(2500) }, { map: s(9000) }, { adminToken: s(128) },
  { chunks: at(14, { label: s(80), text: s(1142) }) }, { chunks: at(8, { text: s(2000) }) },
  { history: at(12, { role: 'user', text: s(4000) }) }, { question: '  ' + s(4000) + '  ' }, { chunks: [{ text: '' }] },
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
  { question: '' }, { question: '   ' }, { question: s(4001) }, { question: undefined }, { question: 7 },
  { quote: s(1201) }, { quote: null }, { focus: s(2501) }, { focus: {} }, { map: s(9001) }, { map: [] },
  { chunks: {} }, { chunks: at(15, { text: 'x' }) }, { chunks: [null] }, { chunks: [['x']] },
  { chunks: [{ label: s(81), text: 'x' }] }, { chunks: [{ label: 'l', text: s(2001) }] }, { chunks: [{ label: 'l' }] },
  { chunks: at(9, { text: s(2000) }) },
  { history: {} }, { history: at(13, { role: 'user', text: 'x' }) }, { history: [{ role: 'system', text: 'x' }] },
  { history: [{ role: 'user', text: s(4001) }] }, { history: [{ role: 'user' }] }, { history: [null] },
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
  ...good, adminToken: s(128), question: s(4000), quote: s(1200), focus: s(2500), map: s(9000),
  chunks: [...at(8, { label: s(80), text: s(2000) }), ...at(6, { label: s(80), text: '' })],
  history: at(12, { role: 'user', text: s(4000) }),
  progress: s(3000), notes: s(1500), thread: s(64), turn: 100,
  facts: at(6, s(300)), tools: ['practice', 'steps', 'cards', 'match', 'figs', 'convert', 'sci', 'forms', 'spell'], kinds: s(1500), check: true
};
assert.ok(validateAsk(biggest));
const jsonChars = JSON.stringify(biggest).length;
const letters = JSON.stringify(biggest).replace(/[{}[\]",:]/g, '').length;
assert.ok(jsonChars + 5 * letters <= LIMITS.body, 'body cap would refuse a valid request');
assert.ok(estimateInputTokens(buildRequest({ model: DEFAULT_MODEL, ...biggest })) < 60000);

/* Nothing the module produces carries an em or en dash. */
assert.ok(!DASH.test(JSON.stringify(buildRequest({ model: 'claude-opus-5', ...full, history: good.history, progress: 'p', notes: 'n' }))));

console.log('study-ask prompt module ok');

/* One list rule, not three. The page's copies must be this regular expression exactly, or a
   phrasing the page treats as a list reaches a server that gives it no room. */
{
  const src = String(LIST_RE);
  const kit = fs.readFileSync(new URL('../../../src/tools/ask_kit.js', import.meta.url), 'utf8');
  const p12 = fs.readFileSync(new URL('../../../src/tools/apushp12_template.html', import.meta.url), 'utf8');
  assert.ok(kit.includes('const LISTQ = ' + src + ';'), 'ask_kit.js has a different list rule');
  assert.ok(p12.includes('const ASK_LISTQ = ' + src + ';'), 'the APUSH template has a different list rule');
  for (const q of ['give me all the cards', 'every term', 'make me a quizlet set', 'list every rule card', 'copy paste them'])
    assert.ok(LIST_RE.test(q), 'the list rule misses: ' + q);
  for (const q of ['who was metacom', 'what does adamant mean', 'why is it K'])
    assert.ok(!LIST_RE.test(q), 'the list rule caught: ' + q);
}
console.log('one list rule everywhere');

/* ---------------------------------------------------------------- trap notes (0025) */
import {
  TRAP_FEATURE, TRAP_MAX_TOKENS, TRAP_MAX_TOKENS_THINKING, TRAP_THINK_OFF, TRAP_LIMITS, TRAP_SYSTEM,
  purposeOf, trapParams, buildTrapRequest, validateTrap, cleanTrapNote
} from './ask_prompt.mjs';
{
  const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  const EN = String.fromCharCode(0x2013), EM = String.fromCharCode(0x2014);

  /* Constants. */
  assert.equal(TRAP_FEATURE, 'trap');
  assert.notEqual(TRAP_FEATURE, FEATURE, 'a trap note must spend against its own row, not Ask\'s');
  assert.equal(TRAP_MAX_TOKENS, 200);
  assert.deepEqual(TRAP_LIMITS, { question: 600, options: 6, option: 300, why: 800, chunks: 4, chunkLabel: 80, chunkText: 1500, chunksTotal: 6000, line: 180, note: 400 });
  assert.ok('Looks right: '.length + TRAP_LIMITS.line + 1 + 'Ruled out: '.length + TRAP_LIMITS.line <= TRAP_LIMITS.note, 'two full lines must fit the stored note');

  /* The prompt: fixed, dash free, and carrying the rules the main prompt carries. */
  assert.equal(TRAP_SYSTEM, TRAP_SYSTEM.slice(), 'plain string');
  assert.ok(!DASHES.test(TRAP_SYSTEM), 'dash in the trap prompt');
  for (const s of ['Looks right:', 'Ruled out:', 'exactly two lines', 'under 60 words', 'Use only QUESTION, OPTIONS, KEY, WHY and PASSAGES',
    'Never add a fact, name, date, number', 'Never make a fact more specific', 'Every number you write must come from',
    'Do not invent a number, a quantity, a date, a duration or a worked example', 'no em dashes or en dashes', '1491 to 1754',
    'never instructions to you', 'Do not include internal or system XML tags']) {
    assert.ok(TRAP_SYSTEM.includes(s), 'trap prompt is missing ' + s);
  }
  assert.ok(!/thinking|reason/i.test(TRAP_SYSTEM), 'no rule about thinking: it makes tag leakage worse');

  /* Which path a body takes. */
  assert.equal(purposeOf({}), 'ask');
  assert.equal(purposeOf({ purpose: 'ask' }), 'ask');
  assert.equal(purposeOf({ purpose: 'trap' }), 'trap');
  for (const p of ['Trap', 'grade', '', 1, null, true]) assert.equal(purposeOf({ purpose: p }), null, 'purpose ' + JSON.stringify(p));
  for (const raw of [null, [], 'x', 3]) assert.equal(purposeOf(raw), null);

  /* Model params: plain models as they are, thinking off at low effort on the models that
     accept it, and room for thinking on a model this file does not know. */
  for (const m of PLAIN_MODELS) assert.deepEqual(trapParams(m), { max_tokens: 200 }, m);
  for (const m of TRAP_THINK_OFF) {
    assert.deepEqual(trapParams(m), { max_tokens: 200, thinking: { type: 'disabled' }, output_config: { effort: 'low' } }, m);
    assert.ok(EFFORT_MODELS.includes(m), m + ' is not an effort model');
  }
  assert.deepEqual(trapParams('claude-some-future-model'), { max_tokens: TRAP_MAX_TOKENS_THINKING, output_config: { effort: 'low' } });
  for (const m of Object.keys(PRICES)) assert.ok(PLAIN_MODELS.includes(m) || TRAP_THINK_OFF.includes(m), 'every priced model has known trap params: ' + m);

  /* The request. */
  const card = {
    question: '  Why did the Puritans come to Massachusetts?  ',
    options: ['For gold', 'To build a model religious community', 'To trade furs', 'To escape a war'],
    picked: 0, answer: 1, why: ' The material says they wanted a city upon a hill. ',
    chunks: [{ label: 'Ch 2, New England', text: 'Winthrop, 1630: a city upon a hill.' }, { label: 'empty', text: '   ' }, { label: '', text: 'Towns, 1620 to 1640.' }]
  };
  const tr = buildTrapRequest({ model: 'claude-sonnet-4-6', ...card });
  assert.deepEqual(Object.keys(tr).sort(), ['max_tokens', 'messages', 'system']);
  assert.deepEqual(tr.system, [{ type: 'text', text: TRAP_SYSTEM }]);
  assert.equal(tr.max_tokens, 200);
  assert.equal(tr.messages.length, 1);
  assert.equal(tr.messages[0].role, 'user');
  assert.equal(tr.messages[0].content, [
    'QUESTION\nWhy did the Puritans come to Massachusetts?',
    'OPTIONS\nA) For gold\nB) To build a model religious community\nC) To trade furs\nD) To escape a war',
    'KEEPS PICKING\nA) For gold',
    'KEY\nB) To build a model religious community',
    'WHY\nThe material says they wanted a city upon a hill.',
    'PASSAGES\n[1] Ch 2, New England: Winthrop, 1630: a city upon a hill.\n\n[3] Towns, 1620 to 1640.'
  ].join('\n\n'));
  const bare = buildTrapRequest({ model: 'claude-opus-5', question: 'q', options: ['a', 'b'], picked: 1, answer: 0 });
  assert.equal(bare.messages[0].content, 'QUESTION\nq\n\nOPTIONS\nA) a\nB) b\n\nKEEPS PICKING\nB) b\n\nKEY\nA) a', 'no WHY or PASSAGES block when there is none');
  assert.deepEqual(bare.thinking, { type: 'disabled' });
  assert.ok(estimateInputTokens(tr) > 0 && estimateInputTokens(tr) < 3000, 'a trap note is small');
  assert.ok(!DASHES.test(JSON.stringify(tr)));

  /* Validation. */
  const tgood = {
    purpose: 'trap', material: 'la10/crucible-1-2', install: '0123456789abcdef0123456789abcdef', adminToken: 'tok',
    question: ' q ', options: [' a ', 'b', 'c'], picked: 2, answer: 0, why: ' w ', chunks: [{ label: 'l', text: 't', ref: 'q:x' }], extra: 'ignored'
  };
  assert.deepEqual(validateTrap(tgood), {
    purpose: 'trap', material: 'la10/crucible-1-2', install: tgood.install, adminToken: 'tok',
    question: 'q', options: ['a', 'b', 'c'], picked: 2, answer: 0, why: 'w', chunks: [{ label: 'l', text: 't' }]
  });
  assert.deepEqual(validateTrap({ purpose: 'trap', material: 'a/b', install: tgood.install, question: 'q', options: ['a', 'b'], picked: 0, answer: 1 }), {
    purpose: 'trap', material: 'a/b', install: tgood.install, adminToken: null, question: 'q', options: ['a', 'b'], picked: 0, answer: 1, why: '', chunks: []
  });
  const s = (n) => 'a'.repeat(n);
  const tok = [
    { question: s(600) }, { options: Array(6).fill(s(300)), picked: 5, answer: 4 }, { why: s(800) }, { why: '' }, { why: undefined },
    { chunks: Array(4).fill({ label: s(80), text: s(1500) }) }, { chunks: [] }, { chunks: undefined }, { chunks: [{ text: '' }] },
    { adminToken: undefined }, { adminToken: s(128) }
  ];
  for (const patch of tok) assert.ok(validateTrap({ ...tgood, ...patch }), 'trap should pass: ' + Object.keys(patch));
  const tbad = [
    null, [], 'x', { ...tgood, purpose: undefined }, { ...tgood, purpose: 'ask' },
    { material: 'crucible' }, { material: 'LA10/c' }, { install: 'abc' }, { adminToken: s(129) }, { adminToken: null },
    { question: '' }, { question: '  ' }, { question: s(601) }, { question: undefined }, { question: 5 },
    { options: undefined }, { options: 'a,b' }, { options: ['only one'], picked: 0, answer: 0 }, { options: Array(7).fill('x') },
    { options: ['a', ''] , picked: 0, answer: 1 }, { options: ['a', s(301)], picked: 0, answer: 1 }, { options: ['a', 2], picked: 0, answer: 1 },
    { picked: undefined }, { picked: '2' }, { picked: 1.5 }, { picked: -1 }, { picked: 3 }, { picked: 0 },
    { answer: undefined }, { answer: 3 }, { answer: null }, { answer: 2 },
    { why: s(801) }, { why: null }, { why: 7 },
    { chunks: {} }, { chunks: Array(5).fill({ text: 'x' }) }, { chunks: [null] }, { chunks: [{ label: 'l' }] },
    { chunks: [{ label: s(81), text: 'x' }] }, { chunks: [{ text: s(1501) }] }, { chunks: [{ text: 5 }] },
    { chunks: [{ text: s(1500) }, { text: s(1500) }, { text: s(1500) }, { text: s(1501) }] }
  ];
  for (const patch of tbad) {
    const body = patch && typeof patch === 'object' && !Array.isArray(patch) && !('purpose' in patch && patch.purpose === undefined) && !(patch.purpose === 'ask') ? { ...tgood, ...patch } : patch;
    assert.equal(validateTrap(body), null, 'trap should fail: ' + JSON.stringify(patch).slice(0, 70));
  }
  assert.equal(validateTrap({ ...tgood, chunks: Array(4).fill({ text: s(1500) }) }).chunks.length, 4, 'four full passages fit the total');
  /* An Ask body is never a trap body, and the largest trap body fits the body cap escaped. */
  assert.equal(validateTrap({ material: 'a/b', install: tgood.install, question: 'x' }), null);
  const tbig = { ...tgood, adminToken: s(128), question: s(600), options: Array(6).fill(s(300)), picked: 5, answer: 4, why: s(800), chunks: Array(4).fill({ label: s(80), text: s(1500) }) };
  assert.ok(validateTrap(tbig));
  assert.ok(JSON.stringify(tbig).length * 6 <= LIMITS.body, 'the body cap would refuse a valid trap request');

  /* The note as it comes back. */
  const want = 'Looks right: Gold drew the Spanish, so it sounds like a reason to sail.\nRuled out: The material says the Puritans came to build a city upon a hill.';
  assert.equal(cleanTrapNote('Looks right: Gold drew the Spanish, so it sounds like a reason to sail.\nRuled out: The material says the Puritans came to build a city upon a hill.', 'end_turn'), want);
  assert.equal(cleanTrapNote('Here is the note:\n\n- **Looks right:** Gold drew the Spanish, so it sounds like a reason to sail.\n- **Ruled out:** The material says the Puritans came to build a city upon a hill.\n', 'end_turn'), want, 'bullets, bold and a preamble are dropped');
  assert.equal(cleanTrapNote('Ruled out: The material says the Puritans came to build a city upon a hill.\nLooks right: Gold drew the Spanish, so it sounds like a reason to sail.', 'end_turn'), want, 'the order is fixed');
  assert.equal(cleanTrapNote('<note>looks right: Gold drew the Spanish, so it sounds like a reason to sail.</note>\nRULED OUT: The material says the Puritans came to build a city upon a hill.'), want, 'tags go, labels are normalized');
  assert.equal(cleanTrapNote('Looks right: It fits 1491' + EN + '1754.\nRuled out: The key names the town ' + EM + ' not the colony.'), 'Looks right: It fits 1491 to 1754.\nRuled out: The key names the town, not the colony.');
  assert.ok(!DASHES.test(cleanTrapNote('Looks right: a ' + EM + ' b.\nRuled out: c' + EN + 'd.')));
  for (const bad of ['', null, undefined, 'Looks right: only one line.', 'Ruled out: only the other.', 'Looks right:\nRuled out: empty first.', 'Two plain sentences.\nWith no labels.']) {
    assert.equal(cleanTrapNote(bad, 'end_turn'), null, 'should not be a note: ' + JSON.stringify(bad));
  }
  assert.equal(cleanTrapNote('Looks right: a.\nRuled out: finished.', 'max_tokens'), 'Looks right: a.\nRuled out: finished.', 'a cut reply whose last line finished is kept');
  assert.equal(cleanTrapNote('Looks right: a.\nRuled out: the material says the', 'max_tokens'), null, 'a cut reply mid sentence is not');
  const long = cleanTrapNote('Looks right: ' + 'word '.repeat(80) + '\nRuled out: ' + 'more '.repeat(80));
  assert.ok(long.split('\n').every((l) => l.replace(/^(Looks right|Ruled out): /, '').length <= TRAP_LIMITS.line), 'each line is held to the limit');
  assert.ok(long.length <= TRAP_LIMITS.note && /\.\.\.$/.test(long));

  /* The Edge Function spends a trap note against the 'trap' row, never Ask's. */
  const src = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function trapNote('), src.indexOf('/* ---------------------------------------------------------------- the handler */'));
  assert.ok(fn.length > 500, 'trapNote not found in index.ts');
  assert.ok(/p_feature: TRAP_FEATURE/.test(fn) && !/p_feature: FEATURE/.test(fn), 'trapNote must call ai_begin2 with the trap feature');
  assert.ok(/feature: TRAP_FEATURE/.test(fn.slice(fn.indexOf('ai_chat_log'))), 'the chat row must say trap');
  assert.ok(/rpc\("ai_end"/.test(fn), 'trapNote must close the ledger row');
  assert.ok(!/\.stream\(/.test(fn), 'a trap note is not streamed');
  assert.ok(/purposeOf\(raw\)/.test(src) && src.indexOf('purposeOf(raw)') < src.indexOf('validateAsk(raw)'), 'the purpose is read before an Ask body is validated');
  assert.ok(!DASHES.test(src), 'dash in index.ts');
}
console.log('trap notes ok');

/* ---------------------------------------------------------------- CHECKED, TOOLS, Check my progress, the review form */
import { TOOL_IDS, TOOL_TEXT, toolsText, CHECKED_RULE, TOOLS_RULE, CHECK_RULE, FORM_RULE, formNumbers } from './ask_prompt.mjs';
{
  const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  const base = { material: 'chem/unit-measurement', install: '0123456789abcdef0123456789abcdef', question: 'x' };
  const sys = systemPrompt();
  for (const rule of [CHECKED_RULE, TOOLS_RULE, CHECK_RULE, FORM_RULE]) {
    assert.ok(sys.includes(rule), 'a new rule is missing from the system prompt: ' + rule.slice(0, 40));
    assert.ok(!DASHES.test(rule), 'dash in a new rule');
  }
  assert.ok(/CHECKED or the student's own message/.test(sys), 'the numbers rule allows CHECKED');
  assert.ok(FORM_RULE.includes('Correct:') && FORM_RULE.includes("Answer written on the student's copy") && FORM_RULE.includes('correct significant figures'), 'the review form rule says to go by Correct');
  assert.ok(CHECK_RULE.includes('PRACTICE KINDS') && CHECK_RULE.includes('square brackets'), 'check my progress builds the set from the kinds');

  /* facts: at most six, each 1 to 300 characters; they go in a CHECKED block before QUESTION. */
  assert.deepEqual(validateAsk({ ...base, facts: ['a', ' b '] }).facts, ['a', 'b']);
  for (const bad of [[], {}, 'a', null].slice(1)) assert.equal(validateAsk({ ...base, facts: bad }), null, 'facts must be an array');
  assert.ok(validateAsk({ ...base, facts: [] }));
  assert.ok(validateAsk({ ...base, facts: at(6, s(300)) }));
  for (const bad of [at(7, 'x'), [s(301)], [''], ['  '], [3], [null]]) assert.equal(validateAsk({ ...base, facts: bad }), null, 'bad facts: ' + JSON.stringify(bad).slice(0, 40));
  const withFacts = buildRequest({ model: 'claude-sonnet-4-6', question: 'how many sig figs in 0.00450', facts: [' Checked by the page: 0.00450 has 3 significant figures. ', ' '] });
  assert.equal(withFacts.messages[0].content, 'CHECKED\n- Checked by the page: 0.00450 has 3 significant figures.\n\nLENGTH\nAbout 200 words, and at most four bullet points.\n\nQUESTION\nhow many sig figs in 0.00450');

  /* tools: known ids only, each once; they add a cached TOOLS block after the map, never to the
     instructions, so every other material keeps its cache. */
  assert.deepEqual(TOOL_IDS, ['practice', 'steps', 'cards', 'match', 'figs', 'convert', 'sci', 'forms', 'spell', 'choose']);
  for (const id of TOOL_IDS) { assert.ok(TOOL_TEXT[id] && TOOL_TEXT[id].toLowerCase().startsWith(id), 'tool text for ' + id); assert.ok(!DASHES.test(TOOL_TEXT[id])); }
  assert.deepEqual(validateAsk({ ...base, tools: ['figs', 'practice'] }).tools, ['figs', 'practice']);
  for (const bad of [['nope'], ['figs', 'figs'], [1], 'figs', {}, at(11, 'figs'), ['Figs']]) assert.equal(validateAsk({ ...base, tools: bad }), null, 'bad tools: ' + JSON.stringify(bad).slice(0, 40));
  assert.equal(validateAsk({ ...base, kinds: s(1501) }), null);
  assert.equal(validateAsk({ ...base, kinds: 7 }), null);
  assert.equal(validateAsk({ ...base, check: 'yes' }), null);
  assert.equal(validateAsk({ ...base, check: true }).check, true);
  const plain = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q' });
  const tooled = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', tools: ['practice', 'figs'], kinds: 'sigmul: Sig figs when multiplying' });
  assert.equal(plain.system.length, 2, 'no tools, no third block');
  assert.equal(tooled.system.length, 3);
  assert.deepEqual(tooled.system.slice(0, 2), plain.system, 'the instructions and the map are unchanged by tools');
  assert.equal(tooled.system[2].text, 'TOOLS\n' + TOOL_TEXT.practice + '\n' + TOOL_TEXT.figs + '\n\nPRACTICE KINDS\nsigmul: Sig figs when multiplying');
  assert.deepEqual(tooled.system[2].cache_control, { type: 'ephemeral' });
  assert.equal(toolsText(['figs'], 'kinds'), 'TOOLS\n' + TOOL_TEXT.figs, 'kinds only ride with practice or steps');
  assert.equal(toolsText([], 'k'), '');
  assert.equal(buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', tools: ['figs'], widgets: false }).system.length, 2, 'widgets off drops the tools');
  const checkReq = buildRequest({ model: 'claude-sonnet-4-6', question: 'Check my progress', progress: 'p', check: true });
  assert.equal(checkReq.messages[0].content, 'PROGRESS\np\n\nThe student tapped Check my progress.\n\nLENGTH\nAbout 200 words, and at most four bullet points.\n\nQUESTION\nCheck my progress');
  assert.ok(!DASHES.test(JSON.stringify(tooled)));

  /* A form question by its number. */
  const nums = (q) => JSON.stringify(formNumbers(q));
  assert.equal(nums('what is question 22'), '[22]');
  assert.equal(nums('explain #33 please'), '[33]');
  assert.equal(nums('q7'), '[7]');
  assert.equal(nums('questions 3 and 4'), '[3,4]');
  assert.equal(nums('problem 12, 13, 14, 15, 16'), '[12,13,14,15]', 'at most four');
  assert.equal(nums('question 33a'), '[33]');
  assert.equal(nums('the numbers 100 and 250'), '[]', 'a number that is not a question number');
  assert.equal(nums('how many sig figs in 1500'), '[]');
  assert.equal(nums('question 900'), '[]');

  /* The Edge Function: the chemistry form is a corpus, fetched by number first, still gated. */
  const idx = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(/"chem\/unit-measurement": "chem-unit-form"/.test(idx), 'chemistry maps to the review form corpus');
  assert.ok(/"apush\/period1-2-test": "fraser-1-4"/.test(idx), 'the APUSH textbook is unchanged');
  const tb = idx.slice(idx.indexOf('body.textbookLabels = [];'), idx.indexOf('return streamAnswer('));
  assert.ok(tb.includes('body.textbook && begun.textbook === true && corpus'), 'the form is behind the same grant as the textbook');
  assert.ok(tb.indexOf('ai_passages_get') > 0 && tb.indexOf('ai_passages_get') < tb.indexOf('ai_passages_search'), 'the numbered rows come before the search');
  assert.ok(tb.includes('p_ords: asked') && tb.includes('formNumbers('), 'fetched by the numbers asked');
  assert.ok(!DASHES.test(idx));
}
console.log('checked facts, tools, check my progress and the review form ok');

/* ------------------------------------------- long messages, chat rules, marking, Note, Choose */
import {
  BEYOND_CORE, SPLIT_RULE, MARKS_CITE, MARKS_OUTSIDE, CAPABILITY_RULE,
  CHAT_RULES_RULE, ITEMS_RULE, CHECKWORK_RULE, NOTE_RULE
} from './ask_prompt.mjs';
{
  const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  const base = { material: 'apush/period1-2-test', install: '0123456789abcdef0123456789abcdef', question: 'x' };
  const s = (n) => 'a'.repeat(n);

  for (const rule of [BEYOND_CORE, SPLIT_RULE, MARKS_CITE, MARKS_OUTSIDE, CAPABILITY_RULE, CHAT_RULES_RULE, ITEMS_RULE, CHECKWORK_RULE, NOTE_RULE]) {
    assert.ok(!DASHES.test(rule), 'dash in a new rule');
  }

  /* What the assistant may say about itself is always in, whichever way beyond is set: the
     refusal that started this round came from having no way to say "I cannot browse". */
  for (const beyond of [false, true]) for (const marks of [false, true]) {
    const p = systemPrompt({ beyond, marks });
    assert.ok(p.includes(CAPABILITY_RULE), 'the capability rule must always be in');
    assert.ok(p.includes(NOTE_RULE), 'the Note rule must always be in');
    assert.ok(p.includes('cannot search the web'), 'it must be able to say it cannot browse');
    assert.ok(!DASHES.test(p));
  }
  /* Beyond off: nothing of its own gets in, so there is nothing to wrap in braces. */
  assert.ok(!systemPrompt({ beyond: false, marks: true }).includes(MARKS_OUTSIDE), 'braces need beyond');
  assert.ok(systemPrompt({ beyond: false, marks: true }).includes(MARKS_CITE), 'passage numbers do not need beyond');
  assert.ok(systemPrompt({ beyond: true, marks: true }).includes(MARKS_OUTSIDE));
  assert.ok(!systemPrompt({ beyond: true, marks: true }).includes(SPLIT_RULE), 'marking replaces the separate paragraph');
  assert.ok(systemPrompt({ beyond: true, marks: false }).includes(SPLIT_RULE), 'the setting can still ask for the paragraph');
  assert.ok(systemPrompt({ beyond: true, marks: false }).includes(BEYOND_CORE));
  assert.ok(!systemPrompt({ beyond: false }).includes(BEYOND_CORE), 'beyond off keeps the old strict rule');
  assert.ok(!systemPrompt({ beyond: false }).includes(SPLIT_RULE));
  /* Every variant is its own cache entry, so each must be byte stable. */
  for (const o of [{}, { marks: true }, { beyond: true }, { beyond: true, marks: true }]) {
    assert.equal(systemPrompt(o), systemPrompt(o), 'a prompt variant is not stable');
  }

  /* CHAT RULES ride in the message, first, so pinning one does not make the next question cold. */
  const ruled = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', rules: ' answer in French ', progress: 'p' });
  const plainReq = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', progress: 'p' });
  assert.deepEqual(ruled.system, plainReq.system, 'a chat rule must not change the cached prefix');
  assert.ok(ruled.messages[0].content.startsWith('CHAT RULES\nanswer in French\n\nPROGRESS\np'), 'rules come first, trimmed');
  assert.ok(ruled.messages[0].content.endsWith('QUESTION\nq\n\n' + CHAT_RULES_RULE), 'the rule instruction follows the question');
  assert.ok(!plainReq.messages[0].content.includes('CHAT RULES'));

  /* A pasted worksheet: the count is stated and the layout rule rides with it. */
  const many = buildRequest({ model: 'claude-sonnet-4-6', question: 'q', items: 5 });
  assert.ok(many.messages[0].content.includes("The student's message holds 5 questions or items. " + ITEMS_RULE));
  assert.deepEqual(many.system, buildRequest({ model: 'claude-sonnet-4-6', question: 'q' }).system, 'items must not change the prefix');
  for (const n of [0, 1, undefined, 'five']) {
    assert.ok(!buildRequest({ model: 'claude-sonnet-4-6', question: 'q', items: n }).messages[0].content.includes(ITEMS_RULE), 'items ' + n + ' is not a list');
  }

  /* Check my answer, and turning the Note line off. */
  assert.ok(buildRequest({ question: 'q', checkwork: true }).messages[0].content.includes(CHECKWORK_RULE));
  assert.ok(!buildRequest({ question: 'q' }).messages[0].content.includes(CHECKWORK_RULE));
  assert.ok(buildRequest({ question: 'q', suggestNotes: false }).messages[0].content.endsWith('Do not add a Note line to this answer.'));
  assert.ok(!buildRequest({ question: 'q' }).messages[0].content.includes('Do not add a Note line'));

  /* Validation of the new fields. */
  assert.equal(validateAsk({ ...base, rules: s(600) }).rules, s(600));
  assert.equal(validateAsk({ ...base, rules: '  keep it short  ' }).rules, 'keep it short');
  assert.equal(validateAsk({ ...base, rules: s(601) }), null);
  assert.equal(validateAsk({ ...base, rules: 5 }), null);
  assert.equal(validateAsk({ ...base, rules: null }), null);
  assert.equal(validateAsk({ ...base, items: 20 }).items, 20);
  assert.equal(validateAsk({ ...base, items: 0 }).items, 0);
  for (const bad of [21, -1, 1.5, '3', null]) assert.equal(validateAsk({ ...base, items: bad }), null, 'bad items: ' + bad);
  for (const k of ['marks', 'checkwork', 'suggestNotes']) {
    assert.equal(validateAsk({ ...base, [k]: 'yes' }), null, k + ' must be a boolean');
  }
  assert.equal(validateAsk({ ...base, marks: true }).marks, true);
  assert.equal(validateAsk({ ...base, suggestNotes: false }).suggestNotes, false);
  assert.equal(validateAsk({ ...base, suggestNotes: undefined }).suggestNotes, true, 'marking notes is the default');

  /* A whole worksheet still fits the body cap and the reserve. */
  const biggest = {
    ...base, question: s(4000), quote: s(1200), focus: s(2500), map: s(9000), adminToken: s(128),
    chunks: Array.from({ length: 8 }, () => ({ label: s(80), text: s(2000) })),
    history: Array.from({ length: 12 }, () => ({ role: 'user', text: s(4000) })),
    progress: s(3000), notes: s(1500), rules: s(600), kinds: s(1500), items: 20
  };
  assert.ok(validateAsk(biggest), 'the biggest valid request must validate');
  assert.ok(JSON.stringify(biggest).length * 6 <= LIMITS.body, 'the body cap would refuse a valid request');
  assert.ok(estimateInputTokens(buildRequest({ model: DEFAULT_MODEL, ...validateAsk(biggest) })) < 60000, 'the reserve must stay under the ceiling');

  /* Choose: the page draws the buttons, so the server only describes the line. */
  assert.ok(TOOL_IDS.includes('choose'));
  assert.ok(/vertical bars/.test(TOOL_TEXT.choose) && /never more than once in a row/.test(TOOL_TEXT.choose));
  assert.ok(/add that line so one tap moves to another/.test(systemPrompt()), 'the clarify rule names Choose');

  /* The Edge Function gives a pasted set room, from what was typed, and logs how it was reached. */
  const idx = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(/const ITEMS_MAX_TOKENS = 2400;/.test(idx), 'the items ceiling is the careful level');
  assert.ok(/body\.question\.length \/ 40/.test(idx), 'the room comes from the question, not from the count sent');
  for (const f of ['route:', 'chunks_sent:', 'cache_read:', 'cache_write:', 'marks:', 'has_rules:', 'items:']) {
    assert.ok(idx.includes(f), 'the chat row is missing ' + f);
  }
  assert.ok(!DASHES.test(idx));
}
console.log('long messages, chat rules, marking, Note and Choose ok');

/* ------------------------------------- corrections, the shelf, the reranker and the one retry */
import {
  CORRECTION_RULE, SHELF_RULE, RETRY_RULE,
  RERANK_FEATURE, RERANK_MODEL, RERANK_MAX_TOKENS, RERANK_LIMITS, RERANK_SYSTEM,
  buildRerankRequest, parseRerank, validateRerank
} from './ask_prompt.mjs';
{
  const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  const base = { material: 'apush/fraser-ch3-4', install: '0123456789abcdef0123456789abcdef', question: 'x' };
  const s = (n) => 'a'.repeat(n);
  const sys = systemPrompt();

  for (const rule of [CORRECTION_RULE, SHELF_RULE, RETRY_RULE]) assert.ok(!DASHES.test(rule));
  assert.ok(sys.includes(CORRECTION_RULE), 'the correction rule must be in the prompt');
  assert.ok(sys.includes(SHELF_RULE), 'the shelf rule must be in the prompt');
  /* A correction is the one thing that may overrule the material, and the prompt has to say so. */
  assert.ok(/the Correction is right/.test(CORRECTION_RULE));
  /* The retry rule rides with the fault, not in the cached prefix. */
  assert.ok(!sys.includes(RETRY_RULE), 'the retry rule must not be cached: most answers never retry');

  /* The one retry. */
  const retried = buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q', fault: 'You wrote 40,000 bushels and nothing backs it.' });
  assert.ok(retried.messages[0].content.includes('FAULT\nYou wrote 40,000 bushels and nothing backs it.\n\n' + RETRY_RULE));
  assert.deepEqual(retried.system, buildRequest({ model: 'claude-sonnet-4-6', map: 'm', question: 'q' }).system, 'a retry must not be a cold question');
  assert.equal(validateAsk({ ...base, fault: s(400) }).fault, s(400));
  assert.equal(validateAsk({ ...base, fault: s(401) }), null);
  assert.equal(validateAsk({ ...base, fault: 9 }), null);
  assert.equal(validateAsk(base).fault, '', 'no fault is the normal case');

  /* The reranker: labels only, a tiny answer, and anything unparseable is simply dropped. */
  assert.equal(RERANK_FEATURE, 'rerank');
  assert.equal(RERANK_MODEL, 'claude-haiku-4-5');
  assert.ok(RERANK_MAX_TOKENS <= 60, 'the reranker answers in numbers, not prose');
  assert.ok(!DASHES.test(RERANK_SYSTEM));
  const labels = Array.from({ length: 12 }, (_, i) => 'Passage number ' + (i + 1));
  const rr = buildRerankRequest({ question: ' which colony ', labels });
  assert.equal(rr.max_tokens, RERANK_MAX_TOKENS);
  assert.ok(rr.messages[0].content.startsWith('QUESTION\nwhich colony\n\nPASSAGES\n1. Passage number 1'));
  assert.ok(!/\bPassage number 13\b/.test(rr.messages[0].content));
  /* It never carries passage text, which is the whole reason it is cheap. */
  assert.ok(rr.messages[0].content.length < 1200, 'the reranker request must stay small');

  assert.deepEqual(parseRerank('4 1 7', 12), [3, 0, 6], 'best first, as indexes');
  assert.deepEqual(parseRerank('none', 12), [], 'none means keep your own order');
  assert.deepEqual(parseRerank('99 0 3', 12), [2], 'out of range numbers are dropped, and 0 is out of range');
  assert.deepEqual(parseRerank('3 3 3', 12), [2], 'no duplicates');
  assert.equal(parseRerank('1 2 3 4 5 6 7 8 9 10', 12).length, RERANK_LIMITS.pick, 'at most eight');
  assert.deepEqual(parseRerank('', 12), []);
  assert.deepEqual(parseRerank(null, 12), []);

  const rv = { material: base.material, install: base.install, question: 'which colony', labels };
  assert.ok(validateRerank(rv));
  assert.equal(validateRerank({ ...rv, labels: ['only one'] }), null, 'one label is not worth a call');
  assert.equal(validateRerank({ ...rv, labels: Array.from({ length: 31 }, () => 'x') }), null);
  assert.equal(validateRerank({ ...rv, labels: [s(101), 'b'] }), null);
  assert.equal(validateRerank({ ...rv, question: '' }), null);
  assert.equal(validateRerank({ ...rv, install: 'short' }), null);
  assert.equal(validateRerank({ ...rv, material: 'nope' }), null);

  assert.equal(purposeOf({ purpose: 'rerank' }), 'rerank');
  assert.equal(purposeOf({ purpose: 'nonsense' }), null);
  assert.equal(purposeOf({}), 'ask');

  /* The Edge Function: the shelf is derived from the class, behind the textbook grant, and a
     retry is billed to its own feature so it has its own cap and the breaker can pause it. */
  const idx = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(/return \/\^\[a-z0-9-\]\{1,40\}\$\/\.test\(cls\) \? "shelf-" \+ cls : "";/.test(idx), 'the shelf corpus comes from the class');
  assert.ok(/shelf && begun\.textbook === true/.test(idx), 'the shelf is behind the same grant as the textbook');
  assert.ok(/p_feature: body\.fault \? "retry" : FEATURE/.test(idx), 'a retry is billed to its own feature');
  assert.ok(idx.indexOf('ai_corrections_get') > 0 && idx.indexOf('ai_corrections_get') < idx.indexOf('return streamAnswer('), 'corrections are fetched before the answer');
  assert.ok(/ahead\.concat\(body\.chunks\)/.test(idx), 'corrections go in front of the material');
  assert.ok(/purpose === "rerank"/.test(idx), 'the rerank purpose is dispatched');
  assert.ok(!DASHES.test(idx));
}
console.log('corrections, shelf, reranker and retry ok');
