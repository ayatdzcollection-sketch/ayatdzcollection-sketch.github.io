/* Merge rules for StudyStore.
 *
 *   node --test study/tests/
 *
 * These load the real assets/sync.js (its pure core is browser-global-free and exported
 * through a CommonJS guard), so there is no second copy of the logic to drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeCode, formatCode,
  mergeEnvelopes, mergeFsrsValue, mergeRegionsDone, mergeExams,
  buildEnvelopeFrom, diffEnvelopes, describeFsrsChange
} = require('../assets/sync.js');

/* ---------- helpers ---------- */

const rec = (s, d, last, reps, lapses) => ({ s, d, last, reps, lapses });

/** envelope from { "ns:key": [value, mtime] } */
function env(spec) {
  const out = { v: 1, ns: {} };
  for (const [full, [value, mtime]] of Object.entries(spec)) {
    const i = full.indexOf(':');
    const ns = full.slice(0, i), key = full.slice(i + 1);
    (out.ns[ns] ||= {})[key] = { value, mtime };
  }
  return out;
}
const fsrsOf = (e, ns = 'fifty-states') => e.ns[ns].fsrs.value;
const merge = (a, b) => mergeEnvelopes(a, b).merged;

/* ---------- fsrs.states: whole-record wins ---------- */

test('same state on both sides: the more recent review wins the WHOLE record', () => {
  // A reviewed Ohio earlier but has more reps; B reviewed it later. B must win outright —
  // mixing A's reps into B's record would describe a review history that never happened.
  const a = env({ 'fifty-states:fsrs': [{ states: { Ohio: rec(9.5, 4, 1000, 12, 1) }, quizDate: null, exams: [] }, 100] });
  const b = env({ 'fifty-states:fsrs': [{ states: { Ohio: rec(2.1, 7, 2000, 3, 0) }, quizDate: null, exams: [] }, 100] });

  const ohio = fsrsOf(merge(a, b)).states.Ohio;
  assert.deepEqual(ohio, rec(2.1, 7, 2000, 3, 0));
  assert.equal(ohio.reps, 3, 'took B.reps, did not keep A.reps');
  assert.equal(ohio.s, 2.1, 'took B.s, did not keep A.s');
});

test('tie on last: larger reps wins, still as a whole record', () => {
  const a = env({ 'fifty-states:fsrs': [{ states: { Utah: rec(1, 5, 5000, 2, 0) }, quizDate: null, exams: [] }, 1] });
  const b = env({ 'fifty-states:fsrs': [{ states: { Utah: rec(8, 3, 5000, 9, 2) }, quizDate: null, exams: [] }, 1] });
  assert.deepEqual(fsrsOf(merge(a, b)).states.Utah, rec(8, 3, 5000, 9, 2));
});

test('double tie resolves deterministically and symmetrically', () => {
  const a = env({ 'fifty-states:fsrs': [{ states: { Iowa: rec(1, 5, 700, 4, 0) }, quizDate: null, exams: [] }, 1] });
  const b = env({ 'fifty-states:fsrs': [{ states: { Iowa: rec(3, 6, 700, 4, 1) }, quizDate: null, exams: [] }, 1] });
  assert.deepEqual(fsrsOf(merge(a, b)).states.Iowa, fsrsOf(merge(b, a)).states.Iowa);
});

test('states present on only one side survive', () => {
  const a = env({ 'fifty-states:fsrs': [{ states: { Maine: rec(4, 5, 900, 3, 0) }, quizDate: null, exams: [] }, 5] });
  const b = env({ 'fifty-states:fsrs': [{ states: { Texas: rec(6, 4, 950, 5, 0) }, quizDate: null, exams: [] }, 5] });
  const states = fsrsOf(merge(a, b)).states;
  assert.deepEqual(Object.keys(states).sort(), ['Maine', 'Texas']);
});

/* ---------- fsrs.exams ---------- */

test('exams: concatenated, deduped by ts, ascending, newest 20 kept', () => {
  const A = Array.from({ length: 15 }, (_, i) => ({ ts: i * 10, exact: true }));
  const B = Array.from({ length: 15 }, (_, i) => ({ ts: 100 + i * 10, exact: false }));
  const out = mergeExams(A, B);
  assert.equal(out.length, 20);
  assert.deepEqual(out.map(e => e.ts), [...out.map(e => e.ts)].sort((x, y) => x - y));
  assert.equal(out.at(-1).ts, 240);
  assert.equal(out[0].ts, 50, 'oldest 10 dropped by the cap');
});

test('exams: duplicate ts collapses to one entry', () => {
  const out = mergeExams([{ ts: 7, exact: false }], [{ ts: 7, exact: true }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].exact, true);
});

/* ---------- quizDate, regionsDone ---------- */

test('quizDate comes from the newer envelope without disturbing states', () => {
  const a = env({ 'fifty-states:fsrs': [{ states: { Ohio: rec(1, 5, 9000, 9, 0) }, quizDate: '2026-09-01', exams: [] }, 50] });
  const b = env({ 'fifty-states:fsrs': [{ states: { Ohio: rec(1, 5, 100, 1, 0) }, quizDate: '2026-10-15', exams: [] }, 900] });
  const m = fsrsOf(merge(a, b));
  assert.equal(m.quizDate, '2026-10-15', 'newer envelope wins quizDate');
  assert.equal(m.states.Ohio.last, 9000, 'but states still merge by last, not by envelope');
});

test('regionsDone is a sorted set union', () => {
  assert.deepEqual(mergeRegionsDone(['r1', 'r3'], ['r2', 'r3']), ['r1', 'r2', 'r3']);
});

/* ---------- unknown keys, registry ---------- */

test('unknown keys fall back to newest-mtime-wins', () => {
  const a = env({ 'future-material:notes': ['old', 10] });
  const b = env({ 'future-material:notes': ['new', 20] });
  assert.equal(merge(a, b).ns['future-material'].notes.value, 'new');
  assert.equal(merge(b, a).ns['future-material'].notes.value, 'new');
});

test('a registered merge function overrides the default', () => {
  const a = env({ 'future-material:score': [3, 10] });
  const b = env({ 'future-material:score': [8, 20] });
  const registry = { 'future-material:score': (x, y) => Math.max(x, y) };
  assert.equal(mergeEnvelopes(a, b, registry).merged.ns['future-material'].score.value, 8);
  const flipped = { 'future-material:score': (x, y) => x + y };
  assert.equal(mergeEnvelopes(a, b, flipped).merged.ns['future-material'].score.value, 11);
});

/* ---------- empty / first sync ---------- */

test('first sync in either direction keeps the populated side', () => {
  const empty = env({});
  const full = env({ 'fifty-states:regionsDone': [['r1'], 5] });
  assert.deepEqual(merge(empty, full).ns['fifty-states'].regionsDone.value, ['r1']);
  assert.deepEqual(merge(full, empty).ns['fifty-states'].regionsDone.value, ['r1']);
  assert.deepEqual(merge(empty, empty), { v: 1, ns: {} });
});

/* ---------- idempotence + commutativity ---------- */

test('merging is idempotent and order-independent', () => {
  const a = env({
    'fifty-states:fsrs': [{ states: { Ohio: rec(2, 5, 500, 2, 0), Iowa: rec(3, 4, 800, 4, 1) }, quizDate: '2026-09-01', exams: [{ ts: 5, exact: true }] }, 100],
    'fifty-states:regionsDone': [['r1', 'r2'], 100]
  });
  const b = env({
    'fifty-states:fsrs': [{ states: { Ohio: rec(9, 2, 1500, 1, 0), Texas: rec(1, 6, 300, 1, 0) }, quizDate: '2026-10-01', exams: [{ ts: 9, exact: false }] }, 200],
    'fifty-states:regionsDone': [['r2', 'r5'], 200]
  });

  const m = merge(a, b);
  assert.deepEqual(merge(a, m), m, 'merge(a, merge(a,b)) == merge(a,b)');
  assert.deepEqual(merge(m, b), m, 'merge(merge(a,b), b) == merge(a,b)');
  assert.deepEqual(merge(b, a), m, 'order does not matter');
});

/* ---------- envelope build, exclusions, diff ---------- */

test('device-local keys never enter an envelope', () => {
  const e = buildEnvelopeFrom(
    { 'fifty-states:fsrs': { states: {} }, 'fifty-states:deck': [1, 2], 'hub:recent': ['x'], 'hub:theme': 'dark' },
    { 'fifty-states:fsrs': 1, 'fifty-states:deck': 1, 'hub:recent': 1, 'hub:theme': 1 },
    true
  );
  assert.ok(e.ns['fifty-states'].fsrs, 'fsrs is synced');
  assert.equal(e.ns['fifty-states'].deck, undefined, 'legacy deck excluded');
  assert.equal(e.ns.hub.recent, undefined, 'recently-opened is device-local');
  assert.ok(e.ns.hub.theme, 'other hub keys still sync');
});

test('diff reports added / changed / unchanged per key', () => {
  const before = env({ 'fifty-states:regionsDone': [['r1'], 10], 'hub:theme': ['dark', 10] });
  const after = env({ 'fifty-states:regionsDone': [['r1', 'r2'], 20], 'hub:theme': ['dark', 10], 'hub:new': ['x', 20] });
  const d = diffEnvelopes(before, after);
  assert.equal(d.namespaces['fifty-states'].regionsDone, 'changed');
  assert.equal(d.namespaces.hub.theme, 'unchanged');
  assert.equal(d.namespaces.hub.new, 'added');
  assert.equal(d.totalChanged, 2);
});

test('the import summary describes fsrs changes in words', () => {
  const before = { states: { Ohio: rec(1, 5, 100, 1, 0) }, quizDate: null, exams: [] };
  const after = { states: { Ohio: rec(2, 4, 200, 2, 0), Iowa: rec(1, 5, 150, 1, 0) }, quizDate: null, exams: [{ ts: 1, exact: true }] };
  const text = describeFsrsChange(before, after);
  assert.match(text, /1 state added/);
  assert.match(text, /1 state updated/);
  assert.match(text, /1 exam result added/);
});

/* ---------- periodic table ----------
   Same rule as the states quiz, over a differently-named record map. Two devices
   drilling different element sets must end up with both. */

test('periodic: cards from both devices survive, newer review wins a shared card', () => {
  const { mergePeriodicFsrs } = require('../assets/sync.js');
  const a = { cards: { 'He|n2s': rec(9, 4, 5000, 6, 0), 'Li|s2n': rec(2, 6, 4000, 2, 0) }, quizDate: null, exams: [] };
  const b = { cards: { 'He|n2s': rec(1, 7, 9000, 1, 0), 'Be|n2s': rec(3, 5, 4500, 3, 0) }, quizDate: null, exams: [] };

  const m = mergePeriodicFsrs(a, b, 10, 10);
  assert.deepEqual(Object.keys(m.cards).sort(), ['Be|n2s', 'He|n2s', 'Li|s2n']);
  assert.deepEqual(m.cards['He|n2s'], rec(1, 7, 9000, 1, 0), 'newer last wins the whole record');
  assert.deepEqual(m.cards['Li|s2n'], rec(2, 6, 4000, 2, 0), 'device A keeps its own card');
  assert.deepEqual(m.cards['Be|n2s'], rec(3, 5, 4500, 3, 0), 'device B contributes its own');
});

test('periodic: the two directions of one element are independent cards', () => {
  const { mergePeriodicFsrs } = require('../assets/sync.js');
  const a = { cards: { 'Na|n2s': rec(8, 3, 9000, 5, 0) }, exams: [], quizDate: null };
  const b = { cards: { 'Na|s2n': rec(1, 8, 100, 1, 2) }, exams: [], quizDate: null };
  const m = mergePeriodicFsrs(a, b, 1, 1);
  assert.equal(Object.keys(m.cards).length, 2, 'name->symbol and symbol->name do not collide');
});

test('periodic: started sets union across devices', () => {
  const a = env({ 'periodic:setsDone': [['s1', 's11'], 10] });
  const b = env({ 'periodic:setsDone': [['s1', 's21'], 20] });
  assert.deepEqual(merge(a, b).ns.periodic.setsDone.value, ['s1', 's11', 's21']);
});

test('periodic and fifty-states never read each other', () => {
  const a = env({
    'fifty-states:fsrs': [{ states: { Ohio: rec(1, 5, 100, 1, 0) }, quizDate: null, exams: [] }, 10],
    'periodic:fsrs': [{ cards: { 'H|n2s': rec(2, 5, 200, 1, 0) }, quizDate: null, exams: [] }, 10]
  });
  const b = env({ 'periodic:fsrs': [{ cards: { 'H|n2s': rec(9, 3, 900, 4, 0) }, quizDate: null, exams: [] }, 20] });
  const m = merge(a, b);
  assert.ok(m.ns['fifty-states'].fsrs.value.states.Ohio, 'the map quiz is untouched');
  assert.equal(m.ns.periodic.fsrs.value.cards['H|n2s'].last, 900, 'the element card took the newer review');
  assert.equal(m.ns.periodic.fsrs.value.states, undefined, 'no cross-contamination of field names');
});

/* ---------- key ordering ----------
   Postgres jsonb reorders object keys, so a record returned by the server is spelled
   differently than the one sent. Merging must not notice. */

test('a server round-trip that only reorders keys is not treated as a change', () => {
  const local = { s: 15.69105, d: 3.2245015893713678, last: 1788130094855, reps: 1, lapses: 0 };
  const fromServer = { d: 3.2245015893713678, s: 15.69105, last: 1788130094855, reps: 1, lapses: 0 };

  const a = env({ 'fifty-states:fsrs': [{ states: { Texas: local }, quizDate: null, exams: [] }, 100] });
  const b = env({ 'fifty-states:fsrs': [{ states: { Texas: fromServer }, quizDate: null, exams: [] }, 100] });

  const m = merge(a, b);
  const picked = fsrsOf(m).states.Texas;
  assert.equal(picked.s, local.s, 'no value changed');
  assert.equal(picked.d, local.d, 'float precision preserved exactly');
  assert.deepEqual(merge(a, b), merge(b, a), 'key order does not decide the tie');
  assert.deepEqual(merge(a, m), m, 'still idempotent across a reordered round-trip');
});

test('reordered keys compare equal, so no needless push is triggered', () => {
  const { deepEqual: eq } = require('../assets/sync.js');
  assert.equal(eq({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 }), true);
  assert.equal(eq({ a: 1 }, { a: 2 }), false, 'real differences still register');
  assert.equal(eq([1, 2], [2, 1]), false, 'array order still matters');
});

/* ---------- pairing codes ---------- */

test('pairing codes are read leniently but validated strictly', () => {
  assert.equal(normalizeCode('  k7q2-9mxr-4b8t '), 'K7Q29MXR4B8T');
  assert.equal(normalizeCode('K7Q2 9MXR 4B8T'), 'K7Q29MXR4B8T');
  assert.equal(normalizeCode('OILU23456789'), '011V23456789', 'ambiguous letters map to their real characters');
  assert.equal(formatCode('K7Q29MXR4B8T'), 'K7Q2-9MXR-4B8T');
  assert.throws(() => normalizeCode('K7Q2-9MXR'), /12 characters/);
  assert.throws(() => normalizeCode('K7Q29MXR4B8!'), /character we do not use/);
  assert.throws(() => normalizeCode(null), /Enter a pairing code/);
});
