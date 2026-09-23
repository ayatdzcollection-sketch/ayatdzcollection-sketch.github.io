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
  mergeNumberSet, mergeSettings, makeEventMerge, mergeMax,
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
  // A reviewed Ohio earlier but has more reps; B reviewed it later. B must win outright.
  // Mixing A's reps into B's record would describe a review history that never happened.
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
  const { mergeCardsFsrs } = require('../assets/sync.js');
  const a = { cards: { 'He|n2s': rec(9, 4, 5000, 6, 0), 'Li|s2n': rec(2, 6, 4000, 2, 0) }, quizDate: null, exams: [] };
  const b = { cards: { 'He|n2s': rec(1, 7, 9000, 1, 0), 'Be|n2s': rec(3, 5, 4500, 3, 0) }, quizDate: null, exams: [] };

  const m = mergeCardsFsrs(a, b, 10, 10);
  assert.deepEqual(Object.keys(m.cards).sort(), ['Be|n2s', 'He|n2s', 'Li|s2n']);
  assert.deepEqual(m.cards['He|n2s'], rec(1, 7, 9000, 1, 0), 'newer last wins the whole record');
  assert.deepEqual(m.cards['Li|s2n'], rec(2, 6, 4000, 2, 0), 'device A keeps its own card');
  assert.deepEqual(m.cards['Be|n2s'], rec(3, 5, 4500, 3, 0), 'device B contributes its own');
});

test('periodic: the two directions of one element are independent cards', () => {
  const { mergeCardsFsrs } = require('../assets/sync.js');
  const a = { cards: { 'Na|n2s': rec(8, 3, 9000, 5, 0) }, exams: [], quizDate: null };
  const b = { cards: { 'Na|s2n': rec(1, 8, 100, 1, 2) }, exams: [], quizDate: null };
  const m = mergeCardsFsrs(a, b, 1, 1);
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


/* ---------- periodic: set size became a setting ---------- */

/* Sets used to be identified as s1, s11, s21: ids that bake a fixed set size of ten into
   the id itself. Once the size is configurable those ids name nothing, so progress moved to
   a plain list of atomic numbers. That list has to stay numeric: mergeRegionsDone would
   have been the obvious rule to reuse and it is the wrong one. */

test('started elements merge as numbers, not as strings', () => {
  const out = mergeNumberSet([2, 10, 1], [3, 10]);
  assert.deepEqual(out, [1, 2, 3, 10], 'numeric order, not lexicographic');
  assert.equal(typeof out[3], 'number', 'members stay numbers or every lookup misses');
  assert.deepEqual(mergeNumberSet(out, []), out, 'idempotent');
  assert.deepEqual(mergeNumberSet([3], [1]), mergeNumberSet([1], [3]), 'order-independent');
});

test('started tolerates the junk a damaged or half-migrated device can send', () => {
  assert.deepEqual(mergeNumberSet(null, [1]), [1]);
  assert.deepEqual(mergeNumberSet(undefined, undefined), []);
  assert.deepEqual(mergeNumberSet(['4', 'x', NaN, null], [4]), [4], 'numeric strings count once, junk is dropped');
});

test('legacy setsDone and the new started list coexist without contaminating each other', () => {
  // The fold from one to the other happens in the material, not here. This pins the
  // boundary: sync must carry both keys intact while old devices are still writing one.
  const a = env({ 'periodic:started': [[1, 2, 3], 100] });
  const b = env({ 'periodic:setsDone': [['s1', 's11'], 200] });
  const m = merge(a, b);
  assert.deepEqual(m.ns.periodic.started.value, [1, 2, 3]);
  assert.deepEqual(m.ns.periodic.setsDone.value, ['s1', 's11']);
});

test('legacy setsDone is still a plain sorted string union', () => {
  const m = merge(env({ 'periodic:setsDone': [['s11'], 1] }),
                  env({ 'periodic:setsDone': [['s1'], 2] }));
  assert.deepEqual(m.ns.periodic.setsDone.value, ['s1', 's11']);
});

/* ---------- settings merge field by field ---------- */

const st = (fields, at, v = 2) => ({ v, at, ...fields });

test('two devices changing different settings both keep their change', () => {
  // The failure this prevents: the phone pushes its whole object, and the setSize it has
  // not touched in a month rides along and overwrites the laptop's.
  const a = st({ setSize: 15, retention: 0.9 }, { setSize: 100, retention: 1 });
  const b = st({ setSize: 10, retention: 0.85 }, { setSize: 1, retention: 200 });
  const m = mergeSettings(a, b, 100, 200);
  assert.equal(m.setSize, 15, "the laptop's newer setSize survives");
  assert.equal(m.retention, 0.85, "the phone's newer retention survives");
});

test('a stale device with the newer envelope cannot clobber an older-stamped field', () => {
  // This is the whole reason the rule exists. Under defaultMerge, b wins everything
  // because its envelope mtime is larger.
  const a = st({ scope: { from: 1, to: 54 } }, { scope: 900 });
  const b = st({ scope: { from: 1, to: 20 } }, { scope: 100 });
  assert.deepEqual(mergeSettings(a, b, 1, 999).scope, { from: 1, to: 54 });
});

test('a setting only one side knows about is never stripped', () => {
  // An older build must not delete a field a newer build added.
  const a = st({ setSize: 10, newField: 'x' }, { setSize: 5, newField: 5 });
  const b = st({ setSize: 20 }, { setSize: 50 });
  const m = mergeSettings(a, b, 10, 20);
  assert.equal(m.newField, 'x', 'unknown field passes through');
  assert.equal(m.setSize, 20, 'known field still resolves by stamp');
});

test('unstamped settings fall back to the envelope mtime', () => {
  // Objects written before per-field stamps existed have no at map at all.
  const a = { setSize: 10 };
  const b = { setSize: 20 };
  assert.equal(mergeSettings(a, b, 100, 200).setSize, 20);
  assert.equal(mergeSettings(a, b, 200, 100).setSize, 10);
});

test('settings merging is idempotent, order-independent and stamps forward', () => {
  const a = st({ setSize: 15, hints: true }, { setSize: 300, hints: 100 });
  const b = st({ setSize: 10, hints: false }, { setSize: 100, hints: 300 });
  const m = mergeSettings(a, b, 1, 2);
  assert.equal(m.at.setSize, 300, 'output stamp is the max of the two');
  assert.equal(m.at.hints, 300);
  assert.deepEqual(mergeSettings(b, a, 2, 1), m, 'order does not matter');
  assert.deepEqual(mergeSettings(a, m, 1, 2), m, 'idempotent');
});

test('an exact stamp tie is broken the same way defaultMerge breaks one', () => {
  const a = st({ setSize: 10 }, { setSize: 500 });
  const b = st({ setSize: 20 }, { setSize: 500 });
  assert.deepEqual(mergeSettings(a, b, 1, 1), mergeSettings(b, a, 1, 1),
    'side-symmetric, or two devices would trade the value forever');
});

/* ---------- event log depth ---------- */

test('graded tests keep a deeper history than practice runs', () => {
  // Drills write to exams constantly. If tests shared that 20-slot log, a week of
  // practice would evict every graded result.
  const many = n => Array.from({ length: n }, (_, i) => ({ ts: i + 1, exact: 1, of: 1 }));
  assert.equal(mergeExams(many(60), []).length, 20, 'fifty-states is untouched');
  assert.equal(makeEventMerge(40)(many(60), []).length, 40);
  assert.equal(makeEventMerge(40)(many(60), [])[0].ts, 21, 'the newest are the ones kept');
});

/* ---------- import preview reads both material shapes ---------- */

test('the import preview counts periodic cards, not only fifty-states states', () => {
  // This reported "no changes" for every periodic import while moving hundreds of records,
  // so the confirmation prompt was asking the user to agree to something it had not read.
  const before = { cards: { 'Na|n2s': rec(1, 5, 10, 1, 0) }, quizDate: null, exams: [] };
  const after = { cards: { 'Na|n2s': rec(9, 5, 99, 2, 0), 'K|s2n': rec(2, 5, 50, 1, 0) }, quizDate: null, exams: [] };
  const line = describeFsrsChange(before, after);
  assert.match(line, /1 card added/);
  assert.match(line, /1 card updated/);
  assert.equal(describeFsrsChange({ states: {} }, { states: { Ohio: rec(1, 5, 1, 1, 0) } }),
    '1 state added', 'fifty-states still says states');
});

/* ---------- credentials never sync ----------
   The auth namespace shares the store prefix with progress, so it was swept into the
   envelope with everything else: the owner's session and the cached decryption keys went
   up to the sync row and down to every paired device, and a sign-out was undone by the
   next merge. */

test('the whole auth namespace is excluded, whatever the key', () => {
  const { isExcluded, SYNC_EXCLUDE_NS } = require('../assets/sync.js');
  assert.equal(SYNC_EXCLUDE_NS.auth, true);
  for (const k of ['token', 'role', 'keys', 'catalog', 'anything-new']) {
    assert.equal(isExcluded('auth', k), true, `auth:${k} must stay on the device`);
  }
  assert.equal(isExcluded('hub', 'telemetry'), false, 'the telemetry preference still syncs');
  assert.equal(isExcluded('hub', 'installId'), true, 'the install id does not');
});

test('building an envelope drops auth keys', () => {
  const e = buildEnvelopeFrom(
    { 'auth:keys': { 'chem/periodic-table': 'c2VjcmV0' }, 'auth:catalog': [], 'periodic:fsrs': { cards: {} } },
    { 'auth:keys': 1, 'auth:catalog': 1, 'periodic:fsrs': 1 },
    true
  );
  assert.equal(e.ns.auth, undefined, 'no auth namespace at all');
  assert.ok(e.ns.periodic.fsrs, 'progress still goes');
});

test('a server row written by an older build is cleaned before merging', () => {
  const { stripExcluded } = require('../assets/sync.js');
  const remote = env({
    'auth:keys': [{ 'chem/periodic-table': 'c2VjcmV0' }, 50],
    'hub:installId': ['abc', 50],
    'hub:telemetry': [true, 50],
    'periodic:started': [[1, 2], 50]
  });
  const clean = stripExcluded(remote);
  assert.equal(clean.ns.auth, undefined);
  assert.equal(clean.ns.hub.installId, undefined);
  assert.equal(clean.ns.hub.telemetry.value, true);
  assert.deepEqual(clean.ns.periodic.started.value, [1, 2]);
  assert.equal(remote.ns.auth.keys.value['chem/periodic-table'], 'c2VjcmV0', 'input untouched');

  // and the merge against a local envelope that lacks them does not bring them back
  const local = env({ 'periodic:started': [[3], 60] });
  const m = merge(local, clean);
  assert.equal(m.ns.auth, undefined, 'a signed-out device stays signed out');
  assert.deepEqual(m.ns.periodic.started.value, [1, 2, 3]);
});

/* ---------- fraser12: the reading quiz shares the cards rule ---------- */

test('fraser12 fsrs merges per card, not whole-object newest-wins', () => {
  // The phone answered a name; the laptop answered a quiz question. Both must survive.
  const a = env({ 'fraser12:fsrs': [{ cards: { nabc: rec(3, 5, 2000, 2, 0) }, quizDate: null, exams: [] }, 100] });
  const b = env({ 'fraser12:fsrs': [{ cards: { qxyz: rec(9, 4, 3000, 1, 0) }, quizDate: null, exams: [] }, 900] });
  const cards = fsrsOf(merge(a, b), 'fraser12').cards;
  assert.deepEqual(Object.keys(cards).sort(), ['nabc', 'qxyz']);
  assert.deepEqual(cards.nabc, rec(3, 5, 2000, 2, 0));
  assert.deepEqual(cards.qxyz, rec(9, 4, 3000, 1, 0));
});

test('fraser12: the later review of one card wins that whole record', () => {
  const a = env({ 'fraser12:fsrs': [{ cards: { q1: rec(12, 3, 5000, 9, 0) }, quizDate: null, exams: [] }, 50] });
  const b = env({ 'fraser12:fsrs': [{ cards: { q1: rec(0.4, 8, 9000, 2, 3) }, quizDate: null, exams: [] }, 50] });
  assert.deepEqual(fsrsOf(merge(a, b), 'fraser12').cards.q1, rec(0.4, 8, 9000, 2, 3));
});

test('fraser12: quiz attempts in exams are unioned and deduped by ts', () => {
  const a = env({ 'fraser12:fsrs': [{ cards: {}, quizDate: null, exams: [{ ts: 1, pts: 6, of: 10 }] }, 1] });
  const b = env({ 'fraser12:fsrs': [{ cards: {}, quizDate: null, exams: [{ ts: 1, pts: 6, of: 10 }, { ts: 2, pts: 9, of: 10 }] }, 1] });
  assert.deepEqual(fsrsOf(merge(a, b), 'fraser12').exams, [{ ts: 1, pts: 6, of: 10 }, { ts: 2, pts: 9, of: 10 }]);
});

test('fraser12: the open tab never leaves the device', () => {
  const built = buildEnvelopeFrom({
    'fraser12:ui': { tab: 'names' },
    'fraser12:fsrs': { cards: { q1: rec(3, 5, 100, 1, 0) }, quizDate: null, exams: [] }
  }, { 'fraser12:ui': 5, 'fraser12:fsrs': 5 });
  assert.equal(built.ns.fraser12.ui, undefined, 'which tab is open is per device');
  assert.ok(built.ns.fraser12.fsrs, 'the schedule does sync');
});

/* ---------- fraser34: chapters 3 and 4 share the same rule ---------- */

test('fraser34 fsrs merges per card, so two devices do not overwrite each other', () => {
  const a = env({ 'fraser34:fsrs': [{ cards: { nzz: rec(4, 5, 2200, 3, 0) }, quizDate: null, exams: [] }, 100] });
  const b = env({ 'fraser34:fsrs': [{ cards: { qww: rec(7, 4, 3300, 1, 0) }, quizDate: null, exams: [] }, 900] });
  const cards = fsrsOf(merge(a, b), 'fraser34').cards;
  assert.deepEqual(Object.keys(cards).sort(), ['nzz', 'qww']);
  assert.deepEqual(cards.nzz, rec(4, 5, 2200, 3, 0));
  assert.deepEqual(cards.qww, rec(7, 4, 3300, 1, 0));
});

test('fraser34: the later review of one card wins that whole record', () => {
  const a = env({ 'fraser34:fsrs': [{ cards: { q1: rec(15, 3, 5000, 9, 0) }, quizDate: null, exams: [] }, 50] });
  const b = env({ 'fraser34:fsrs': [{ cards: { q1: rec(0.3, 9, 9500, 2, 4) }, quizDate: null, exams: [] }, 50] });
  assert.deepEqual(fsrsOf(merge(a, b), 'fraser34').cards.q1, rec(0.3, 9, 9500, 2, 4));
});

test('fraser34: the open tab and the open guide section stay on the device', () => {
  const built = buildEnvelopeFrom({
    'fraser34:ui': { tab: 'guide', sec: 'slavesociety' },
    'fraser34:fsrs': { cards: { q1: rec(3, 5, 100, 1, 0) }, quizDate: null, exams: [] }
  }, { 'fraser34:ui': 5, 'fraser34:fsrs': 5 });
  assert.equal(built.ns.fraser34.ui, undefined, 'the open tab and section are per device');
  assert.ok(built.ns.fraser34.fsrs, 'the schedule does sync');
});

/* ---------- chemunit: the chemistry unit test ----------
   Worked problem types ('g:metric') and concept cards share one record, and the list of
   missed problems rides along on it, newest write winning, like quizDate. */
test('chemunit fsrs merges per card, so a phone and a laptop both keep their reviews', () => {
  const a = env({ 'chemunit:fsrs': [{ cards: { 'g:metric': rec(2, 5, 2200, 3, 0) }, quizDate: '2026-09-22', exams: [] }, 100] });
  const b = env({ 'chemunit:fsrs': [{ cards: { 'c1abc': rec(4, 4, 3300, 2, 0) }, quizDate: '2026-09-22', exams: [] }, 900] });
  const cards = fsrsOf(merge(a, b), 'chemunit').cards;
  assert.ok(cards['g:metric'], 'the problem type reviewed on one device survives');
  assert.ok(cards['c1abc'], 'the concept card reviewed on the other survives');
});

test('chemunit: the open tab, rule and deck stay on the device', () => {
  const built = buildEnvelopeFrom({
    'chemunit:ui': { tab: 'cards', deck: 'missed', at: 3 },
    'chemunit:fsrs': { cards: { 'g:da': rec(3, 5, 100, 1, 0) }, quizDate: '2026-09-22', exams: [] }
  }, { 'chemunit:ui': 5, 'chemunit:fsrs': 5 });
  assert.equal(built.ns.chemunit.ui, undefined, 'the open tab and deck are per device');
  assert.ok(built.ns.chemunit.fsrs, 'the schedule does sync');
});

/* ---------- acct1: accounting 1, topic 1 ----------
   Built from the APUSH chapters 3-4 material, so the same record shape and the same rule.
   A Learn session's progress lives in ui, which stays on the device. */
test('acct1 fsrs merges per card, so a phone and a laptop both keep their reviews', () => {
  const a = env({ 'acct1:fsrs': [{ cards: { 'q1abc': rec(2, 5, 2200, 3, 0) }, quizDate: '2026-09-15', exams: [] }, 100] });
  const b = env({ 'acct1:fsrs': [{ cards: { 'n9xyz': rec(4, 4, 3300, 2, 0) }, quizDate: '2026-09-15', exams: [] }, 900] });
  const cards = fsrsOf(merge(a, b), 'acct1').cards;
  assert.ok(cards['q1abc'], 'the question reviewed on one device survives');
  assert.ok(cards['n9xyz'], 'the term reviewed on the other survives');
});

test('acct1: the open tab and a Learn session stay on the device', () => {
  const built = buildEnvelopeFrom({
    'acct1:ui': { tab: 'learn', learn: { deck: 'sec-principles', st: {} } },
    'acct1:fsrs': { cards: { 'q1abc': rec(3, 5, 100, 1, 0) }, quizDate: null, exams: [] }
  }, { 'acct1:ui': 5, 'acct1:fsrs': 5 });
  assert.equal(built.ns.acct1.ui, undefined, 'the tab and the Learn session are per device');
  assert.ok(built.ns.acct1.fsrs, 'the schedule does sync');
});

/* ---------- la10crucible and apushp12: the materials on the shared core ----------
   Same { cards, quizDate, exams } shape, same per card rule; ui (tab, pace, open stretch)
   is per device. */
for (const ns of ['la10crucible', 'apushp12', 'apush5saq', 'psychu0', 'la10vocab1', 'frchateaux']) {
  test(ns + ' fsrs merges per card', () => {
    const a = env({ [ns + ':fsrs']: [{ cards: { 't1abc': rec(2, 5, 2200, 3, 0) }, quizDate: '2026-09-15', exams: [] }, 100] });
    const b = env({ [ns + ':fsrs']: [{ cards: { 'q9xyz': rec(4, 4, 3300, 2, 0) }, quizDate: '2026-09-15', exams: [] }, 900] });
    const cards = fsrsOf(merge(a, b), ns).cards;
    assert.ok(cards['t1abc'], 'the card reviewed on one device survives');
    assert.ok(cards['q9xyz'], 'the card reviewed on the other survives');
  });
  test(ns + ': ui stays on the device', () => {
    const built = buildEnvelopeFrom({
      [ns + ':ui']: { tab: 'home', pace: { tf: 3000 } },
      [ns + ':fsrs']: { cards: { 't1abc': rec(3, 5, 100, 1, 0) }, quizDate: null, exams: [] }
    }, { [ns + ':ui']: 5, [ns + ':fsrs']: 5 });
    assert.equal(built.ns[ns].ui, undefined, 'ui is per device');
    assert.ok(built.ns[ns].fsrs, 'the schedule does sync');
  });
}

/* ---------- apush5saq: lessons done travel inside ui ----------
   The chapter 5 lessons keep { f, done } per lesson in ui.les. The tab stays on the device;
   a lesson finished on the phone must still read as finished on the laptop. */
test('apush5saq: lessons and must knows travel, the tab does not', () => {
  const built = buildEnvelopeFrom({
    'apush5saq:ui': { tab: 'lessons', les: { 'l-saq': { f: 9, done: 1790000000000 } }, mk: { acts: { 0: 1 } } },
    'apush5saq:fsrs': { cards: {}, quizDate: '2026-09-24', exams: [] }
  }, { 'apush5saq:ui': 5, 'apush5saq:fsrs': 5 });
  assert.equal(built.ns.apush5saq.ui, undefined, 'the tab is per device');
  assert.deepEqual(SYNC_PARTIAL.apush5saq, ['mk', 'les'], 'must knows and lessons are the partial fields');
  const m = mergeMarks({ les: { a: { f: 3 } } }, { les: { a: { f: 9, done: 1790000000000 }, b: { f: 2 } } }, 1, 2);
  assert.equal(m.les.a.done, 1790000000000, 'done survives a merge with a copy that had not finished');
  assert.ok(m.les.b, 'a lesson started only on the other device survives');
});

/* ---------- periodic:best ----------
   The sprint best is a maximum. It had no rule, so the device that saved last won even with
   the lower score. */
test('periodic best keeps the higher score whichever device wrote last', () => {
  const a = env({ 'periodic:best': [22, 100] });
  const b = env({ 'periodic:best': [14, 900] });
  assert.equal(merge(a, b).ns.periodic.best.value, 22);
  assert.equal(merge(b, a).ns.periodic.best.value, 22);
  assert.equal(mergeMax(null, 5), 5);
});

/* ---------- apushp12:asknotes ----------
   Notes kept beside Ask: [{ ts, t, del }], ts is the identity. Newest write wins would drop
   a note written on the other device, and would resurrect a note deleted on this one. */

const { mergeAskNotes, BUILTIN_MERGES, isExcluded: askExcluded } = require('../assets/sync.js');
const note = (ts, t) => ({ ts, t });
const gone = ts => ({ ts, t: '', del: true });
const deepFreeze = v => {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};

test('asknotes: registered for apushp12, and it syncs while ui stays on the device', () => {
  assert.equal(BUILTIN_MERGES['apushp12:asknotes'], mergeAskNotes);
  assert.equal(askExcluded('apushp12', 'asknotes'), false, 'the notes travel');
  assert.equal(askExcluded('apushp12', 'ui'), true, 'ui still does not');
  const built = buildEnvelopeFrom({
    'apushp12:ui': { tab: 'ask' },
    'apushp12:asknotes': [note(1, 'x')]
  }, { 'apushp12:ui': 5, 'apushp12:asknotes': 5 });
  assert.equal(built.ns.apushp12.ui, undefined);
  assert.deepEqual(built.ns.apushp12.asknotes.value, [note(1, 'x')]);
});

test('asknotes: notes from both devices are unioned by ts, whichever envelope is newer', () => {
  const a = env({ 'apushp12:asknotes': [[note(10, 'phone'), note(30, 'both')], 100] });
  const b = env({ 'apushp12:asknotes': [[note(20, 'laptop'), note(30, 'both')], 900] });
  const want = [note(10, 'phone'), note(20, 'laptop'), note(30, 'both')];
  assert.deepEqual(merge(a, b).ns.apushp12.asknotes.value, want, 'the older envelope loses no note');
  assert.deepEqual(merge(b, a).ns.apushp12.asknotes.value, want);
});

test('asknotes: a delete on either side wins, and the tombstone keeps no text', () => {
  const live = [note(5, 'keep me'), note(6, 'other')];
  const deleted = [{ ts: 5, t: 'keep me', del: true }];
  const want = [gone(5), note(6, 'other')];
  assert.deepEqual(mergeAskNotes(live, deleted), want);
  assert.deepEqual(mergeAskNotes(deleted, live), want);
  // a longer edit on the other device does not bring the deleted note back
  assert.deepEqual(mergeAskNotes([note(5, 'a much longer edit of the note')], [gone(5)]), [gone(5)]);
  // and the result merged with the old live copy again stays deleted
  assert.deepEqual(mergeAskNotes(want, live), want);
});

test('asknotes: the same ts with different text keeps the longer text', () => {
  assert.deepEqual(mergeAskNotes([note(1, 'short')], [note(1, 'short, then edited')]), [note(1, 'short, then edited')]);
  assert.deepEqual(mergeAskNotes([note(1, 'short, then edited')], [note(1, 'short')]), [note(1, 'short, then edited')]);
});

test('asknotes: deterministic, sorted by ts, order independent and idempotent', () => {
  const a = [note(40, 'd'), note(10, 'a'), gone(25), note(7, 'abc')];
  const b = [note(7, 'xyz'), note(30, 'c'), note(10, 'a')];
  const m = mergeAskNotes(a, b);
  assert.deepEqual(m.map(n => n.ts), [7, 10, 25, 30, 40]);
  assert.deepEqual(mergeAskNotes(b, a), m, 'same result in either direction');
  assert.equal(m[0].t, 'xyz', 'an equal length tie is broken the same way from both sides');
  assert.deepEqual(mergeAskNotes(m, a), m, 'idempotent');
  assert.deepEqual(mergeAskNotes(m, m), m);
  assert.deepEqual(JSON.stringify(mergeAskNotes(a, b)), JSON.stringify(m), 'same key order too');
});

test('asknotes: inputs are never mutated', () => {
  const a = deepFreeze([note(3, 'x'.repeat(400)), { ts: 4, t: 'dup', del: true }]);
  const b = deepFreeze([note(4, 'dup, longer'), note(1, 'y')]);
  const before = JSON.stringify([a, b]);
  const m = mergeAskNotes(a, b);
  assert.equal(JSON.stringify([a, b]), before);
  assert.notEqual(m[0], b[1], 'entries are copies, not the input objects');
});

test('asknotes: capped at 80, oldest tombstones dropped before any note', () => {
  const notes = Array.from({ length: 70 }, (_, i) => note(1000 + i, 'n' + i));
  const dead = Array.from({ length: 20 }, (_, i) => gone(i + 1));
  const m = mergeAskNotes(notes, dead);
  assert.equal(m.length, 80);
  assert.equal(m.filter(n => !n.del).length, 70, 'every note survives');
  assert.deepEqual(m.filter(n => n.del).map(n => n.ts), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    'the ten oldest tombstones are the ones dropped');
});

test('asknotes: past the tombstones, the oldest notes go and the newest stay', () => {
  const notes = Array.from({ length: 100 }, (_, i) => note(i + 1, 'n' + i));
  const m = mergeAskNotes(notes, [gone(500), gone(501)]);
  assert.equal(m.length, 80);
  assert.equal(m.filter(n => n.del).length, 0, 'both tombstones went first');
  assert.equal(m[0].ts, 21, 'the twenty oldest notes were dropped');
  assert.equal(m.at(-1).ts, 100);
  assert.equal(mergeAskNotes(m, m).length, 80, 'a capped list stays put');
});

test('asknotes: tolerates junk from a damaged device', () => {
  assert.deepEqual(mergeAskNotes(null, undefined), []);
  assert.deepEqual(mergeAskNotes({ ts: 1, t: 'x' }, 'notes'), [], 'non arrays count as empty');
  assert.deepEqual(mergeAskNotes(42, [note(2, 'ok')]), [note(2, 'ok')]);
  const junk = [
    null, 7, 'text', [], { t: 'no ts' }, { ts: '5', t: 'string ts' }, { ts: NaN, t: 'nan' },
    { ts: Infinity, t: 'inf' }, { ts: null, t: 'null ts' },
    { ts: 9, t: 12345 }, { ts: 8, t: 'z'.repeat(350) }, { ts: 6, t: 'soft', del: 'yes' }
  ];
  const m = mergeAskNotes(junk, []);
  assert.deepEqual(m.map(n => n.ts), [6, 8, 9], 'only entries with a finite numeric ts survive');
  assert.equal(m[0].del, undefined, 'del counts only when it is true');
  assert.equal(m[1].t.length, 300, 'text is held to 300 characters');
  assert.equal(m[2].t, '', 'a non string text becomes empty');
});

test('every material with Ask merges its saved notes the same way', () => {
  for (const ns of ['apushp12', 'fraser12', 'fraser34', 'fraserall', 'fraser5', 'acct1', 'chemunit', 'periodic', 'alg2u1', 'fifty-states', 'la10crucible', 'psychu0', 'la10vocab1', 'frchateaux']) {
    assert.equal(BUILTIN_MERGES[ns + ':asknotes'], BUILTIN_MERGES['apushp12:asknotes'], ns);
  }
});

/* ---------- <ns>:trapnotes ----------
   Trap notes (migration 0025): { <card id>: { ts, t, w } }, one per card, bought with the one AI
   call that card is ever allowed. { ts, none: true } marks a call that gave no usable note. Newest
   write wins would drop a note written on the other device and make someone pay for it again. */

const { mergeTrapNotes } = require('../assets/sync.js');
const trapNote = (ts, t, w = 1) => ({ ts, t, w });
const trapNone = (ts, w = 1) => ({ ts, none: true, w });

test('trapnotes: registered for every page that can write one, and it syncs', () => {
  for (const ns of ['la10crucible', 'psychu0', 'la10vocab1', 'frchateaux', 'apushp12', 'chemunit']) {
    assert.equal(BUILTIN_MERGES[ns + ':trapnotes'], mergeTrapNotes, ns);
    assert.equal(askExcluded(ns, 'trapnotes'), false, ns + ': the notes travel');
  }
});

test('trapnotes: notes from both devices are unioned by card id, whichever envelope is newer', () => {
  const a = env({ 'la10crucible:trapnotes': [{ q1: trapNote(10, 'phone') }, 100] });
  const b = env({ 'la10crucible:trapnotes': [{ q2: trapNote(20, 'laptop', 2) }, 900] });
  const want = { q1: trapNote(10, 'phone'), q2: trapNote(20, 'laptop', 2) };
  assert.deepEqual(merge(a, b).ns.la10crucible.trapnotes.value, want, 'the older envelope loses no note');
  assert.deepEqual(merge(b, a).ns.la10crucible.trapnotes.value, want);
});

test('trapnotes: a note beats a paid for marker, from either side', () => {
  assert.deepEqual(mergeTrapNotes({ q1: trapNone(5) }, { q1: trapNote(9, 'the note') }), { q1: trapNote(9, 'the note') });
  assert.deepEqual(mergeTrapNotes({ q1: trapNote(9, 'the note') }, { q1: trapNone(5) }), { q1: trapNote(9, 'the note') });
  assert.deepEqual(mergeTrapNotes({ q1: trapNone(5) }, { q1: trapNone(3) }), { q1: trapNone(3) }, 'two markers keep the earlier');
});

test('trapnotes: two notes for one card keep the earlier, then the longer', () => {
  const early = trapNote(100, 'written first'), late = trapNote(200, 'written second, longer');
  assert.deepEqual(mergeTrapNotes({ q1: early }, { q1: late }), { q1: early });
  assert.deepEqual(mergeTrapNotes({ q1: late }, { q1: early }), { q1: early });
  assert.deepEqual(mergeTrapNotes({ q1: trapNote(7, 'short') }, { q1: trapNote(7, 'short, longer') }), { q1: trapNote(7, 'short, longer') });
  assert.deepEqual(mergeTrapNotes({ q1: trapNote(7, 'short, longer') }, { q1: trapNote(7, 'short') }), { q1: trapNote(7, 'short, longer') });
});

test('trapnotes: deterministic, order independent, idempotent, keys sorted', () => {
  const a = { q9: trapNote(40, 'd'), q1: trapNote(10, 'abc'), q5: trapNone(25) };
  const b = { q1: trapNote(10, 'xyz'), q3: trapNote(30, 'c'), q5: trapNote(26, 'late note') };
  const m = mergeTrapNotes(a, b);
  assert.deepEqual(Object.keys(m), ['q1', 'q3', 'q5', 'q9']);
  assert.equal(m.q1.t, 'xyz', 'an equal ts, equal length tie is broken the same way from both sides');
  assert.equal(m.q5.t, 'late note', 'the note replaced the marker');
  assert.deepEqual(mergeTrapNotes(b, a), m, 'same result in either direction');
  assert.equal(JSON.stringify(mergeTrapNotes(b, a)), JSON.stringify(m), 'same key order too');
  assert.deepEqual(mergeTrapNotes(m, a), m, 'idempotent');
  assert.deepEqual(mergeTrapNotes(m, m), m);
});

test('trapnotes: inputs are never mutated and entries are copies', () => {
  const a = deepFreeze({ q1: trapNote(3, 'x'.repeat(500)), q2: trapNone(4) });
  const b = deepFreeze({ q2: trapNote(5, 'real'), q3: trapNote(1, 'y') });
  const before = JSON.stringify([a, b]);
  const m = mergeTrapNotes(a, b);
  assert.equal(JSON.stringify([a, b]), before);
  assert.notEqual(m.q3, b.q3, 'entries are copies, not the input objects');
  assert.equal(m.q1.t.length, 400, 'text is held to 400 characters');
});

test('trapnotes: capped at 500 cards, oldest markers dropped before any note', () => {
  const a = {}, b = {};
  for (let i = 0; i < 480; i++) a['n' + i] = trapNote(1000 + i, 'note ' + i);
  for (let i = 0; i < 40; i++) b['m' + i] = trapNone(i + 1);
  const m = mergeTrapNotes(a, b);
  assert.equal(Object.keys(m).length, 500);
  assert.equal(Object.values(m).filter(e => e.t).length, 480, 'every note survives');
  assert.deepEqual(Object.keys(m).filter(k => k[0] === 'm').sort((x, y) => m[x].ts - m[y].ts).map(k => m[k].ts),
    Array.from({ length: 20 }, (_, i) => i + 21), 'the twenty oldest markers are the ones dropped');
  const many = {};
  for (let i = 0; i < 520; i++) many['c' + i] = trapNote(i + 1, 'n');
  const capped = mergeTrapNotes(many, {});
  assert.equal(Object.keys(capped).length, 500);
  assert.equal(capped.c0, undefined, 'the oldest notes go last, and only past the cap');
  assert.equal(capped.c519.ts, 520);
  assert.deepEqual(mergeTrapNotes(capped, capped), capped, 'a capped map stays put');
});

test('trapnotes: tolerates junk from a damaged device', () => {
  assert.deepEqual(mergeTrapNotes(null, undefined), {});
  assert.deepEqual(mergeTrapNotes([trapNote(1, 'x')], 'notes'), {}, 'non objects count as empty');
  assert.deepEqual(mergeTrapNotes(42, { q2: trapNote(2, 'ok') }), { q2: trapNote(2, 'ok') });
  const junk = JSON.parse('{"__proto__": {"ts": 1, "t": "proto"}}');
  Object.assign(junk, {
    'has space': trapNote(1, 'bad id'), ['x'.repeat(81)]: trapNote(1, 'long id'), q1: null, q2: 7, q3: 'text',
    q4: { t: 'no ts' }, q5: { ts: '5', t: 'string ts' }, q6: { ts: NaN, t: 'nan' }, q7: { ts: Infinity, t: 'inf' },
    q8: { ts: 8, t: 12345 }, q9: { ts: 9, t: '' }, q10: { ts: 10, t: 'kept', w: 1.5 }, q11: { ts: 11, t: 'kept', w: 11 },
    q12: { ts: 12, t: 'contradiction', none: true }
  });
  const m = mergeTrapNotes(junk, {});
  assert.deepEqual(Object.keys(m), ['q10', 'q11', 'q12', 'q8', 'q9'], 'only plain ids with a finite numeric ts survive');
  assert.deepEqual(m.q8, { ts: 8, none: true }, 'a non string text is a marker, not a note');
  assert.deepEqual(m.q9, { ts: 9, none: true });
  assert.deepEqual(m.q10, { ts: 10, t: 'kept' }, 'a w that is not a small whole number is dropped');
  assert.deepEqual(m.q11, { ts: 11, t: 'kept' });
  assert.deepEqual(m.q12, { ts: 12, none: true }, 'none wins over text on one entry');
  assert.equal(Object.getPrototypeOf(m), Object.prototype);
});

test('trapnotes: chemistry concept card notes merge per card like every other page', () => {
  /* Concept card ids are 'c' plus a base 36 hash; the problem types are never trap notes. */
  const a = env({ 'chemunit:trapnotes': [{ c1ygsiby: trapNote(10, 'Looks right: phone.\nRuled out: phone.', 2) }, 100] });
  const b = env({ 'chemunit:trapnotes': [{ c0abc12: trapNone(20, 1) }, 900] });
  const want = { c0abc12: trapNone(20, 1), c1ygsiby: trapNote(10, 'Looks right: phone.\nRuled out: phone.', 2) };
  assert.deepEqual(merge(a, b).ns.chemunit.trapnotes.value, want, 'a note from the phone and a marker from the laptop both survive');
  assert.deepEqual(merge(b, a).ns.chemunit.trapnotes.value, want);
  assert.deepEqual(mergeTrapNotes({ c1ygsiby: trapNone(5) }, { c1ygsiby: trapNote(9, 'the note') }), { c1ygsiby: trapNote(9, 'the note') }, 'a note beats a paid for marker');
  assert.equal(askExcluded('chemunit', 'trapnotes'), false, 'the notes travel with the sync code');
});

/* ---------- 2026-09-19: nothing a material keeps may be deleted by a merge ---------- */

const { mergeMarks, mergeChemUnitFsrs, mergeCardsFsrs: cardsMerge, BUILTIN_MERGES: REG, SYNC_PARTIAL } = require('../assets/sync.js');

test('fsrs: a field the rule does not know is kept, not deleted', () => {
  const a = { cards: { x: rec(1, 5, 100, 1, 0) }, quizDate: null, exams: [], streak: 4 };
  const b = { cards: { y: rec(1, 5, 200, 1, 0) }, quizDate: null, exams: [] };
  assert.equal(cardsMerge(a, b, 10, 20).streak, 4, 'only one side has it');
  assert.equal(cardsMerge(b, a, 20, 10).streak, 4);
  assert.equal(cardsMerge({ ...a, streak: 4 }, { ...b, streak: 9 }, 10, 20).streak, 9, 'both: the later write');
  assert.equal(cardsMerge({ ...b, streak: 9 }, { ...a, streak: 4 }, 20, 10).streak, 9);
});

test('chemunit fsrs: missed, start and lastWorked survive a sync, from both devices', () => {
  const phone = { cards: { 'g:metric': rec(1, 5, 100, 1, 0) }, quizDate: '2026-09-22', exams: [{ ts: 1, pts: 3, of: 5 }],
    missed: [{ ts: 300, type: 'metric', q: 'p2' }, { ts: 100, type: 'sigadd', q: 'p1' }], start: '2026-09-12', lastWorked: 300 };
  const laptop = { cards: { c1: rec(2, 5, 250, 2, 0) }, quizDate: '2026-09-22', exams: [{ ts: 2, pts: 4, of: 5 }],
    missed: [{ ts: 200, type: 'density', q: 'l1' }, { ts: 100, type: 'sigadd', q: 'p1' }], start: '2026-09-15', lastWorked: 250 };
  const m = mergeChemUnitFsrs(phone, laptop, 300, 250), r = mergeChemUnitFsrs(laptop, phone, 250, 300);
  assert.deepEqual(m, r, 'both directions agree');
  assert.deepEqual(m.missed.map(x => x.ts), [300, 200, 100], 'union by ts, newest first as the page keeps it');
  assert.equal(m.start, '2026-09-12');
  assert.equal(m.lastWorked, 300);
  assert.equal(m.exams.length, 2);
  assert.deepEqual(Object.keys(m.cards).sort(), ['c1', 'g:metric']);
  /* The bug itself: a device merging with its own copy on the server lost the list. */
  assert.deepEqual(mergeChemUnitFsrs(phone, phone, 300, 300).missed, phone.missed);
  assert.equal(REG['chemunit:fsrs'], mergeChemUnitFsrs);
  const many = Array.from({ length: 60 }, (_, i) => ({ ts: 1000 + i }));
  assert.equal(mergeChemUnitFsrs({ cards: {}, missed: many.slice(0, 40) }, { cards: {}, missed: many.slice(20) }, 1, 2).missed.length, 40);
  assert.equal(mergeChemUnitFsrs({ cards: {}, exams: many.slice(0, 30) }, { cards: {}, exams: [] }, 1, 2).exams.length, 30, 'the page keeps 30 sets');
});

test('fsrs: a star taken off after a sync stays off', () => {
  const starred = { ...rec(1, 5, 100, 1, 0), star: 1 }, cleared = { ...rec(1, 5, 100, 1, 0), star: 0 };
  assert.equal(cardsMerge({ cards: { c: cleared } }, { cards: { c: starred } }, 900, 100).cards.c.star, 0);
  assert.equal(cardsMerge({ cards: { c: starred } }, { cards: { c: cleared } }, 100, 900).cards.c.star, 0);
  assert.equal(cardsMerge({ cards: { c: starred } }, { cards: { c: rec(1, 5, 500, 2, 0) } }, 900, 100).cards.c.last, 500, 'a real review still wins');
});

test('uimarks: progress kept in the device-only ui key is a union', () => {
  const a = { mk: { s1: { 0: 1, 1: 0 } }, walked: { a1: 1758000000000 } };
  const b = { mk: { s1: { 1: 1, 2: 1 }, s2: { 0: 1 } }, walked: { a1: 1758000900000, a2: 1758000500000 } };
  const want = { mk: { s1: { 0: 1, 1: 1, 2: 1 }, s2: { 0: 1 } }, walked: { a1: 1758000900000, a2: 1758000500000 } };
  assert.deepEqual(mergeMarks(a, b, 100, 900), want);
  assert.deepEqual(mergeMarks(b, a, 900, 100), want);
  assert.deepEqual(mergeMarks(a, undefined, 1, 2), a);
  for (const ns of Object.keys(SYNC_PARTIAL)) assert.equal(REG[ns + ':uimarks'], mergeMarks, ns);
});

test('every material that writes trap notes or ask notes has a rule for them', () => {
  for (const ns of ['periodic', 'fraserall', 'fraser5', 'acct1', 'chemunit', 'la10crucible', 'apushp12', 'apush5saq', 'psychu0', 'la10vocab1', 'frchateaux']) {
    assert.equal(typeof REG[ns + ':trapnotes'], 'function', ns + ' trapnotes');
    assert.equal(typeof REG[ns + ':asknotes'], 'function', ns + ' asknotes');
    assert.equal(typeof REG[ns + ':fsrs'], 'function', ns + ' fsrs');
  }
});

test('chemunit fsrs: topics taught on either device stay taught', () => {
  const m = mergeChemUnitFsrs({ cards: {}, taught: { sci: 1758000000000 } }, { cards: {}, taught: { den: 1758000500000, sci: 1758000900000 } }, 5, 9);
  assert.deepEqual(m.taught, { sci: 1758000900000, den: 1758000500000 });
});

/* ---------- 2026-09-19: every key every material writes needs a rule ---------- */

const { makeSittingMerge, mergeQuizDraft, mergeSkillCounts } = require('../assets/sync.js');

/* What each live material actually writes, read off its source with
 *   grep -oE "store\.(set|get)\('[A-Za-z0-9_]+'" study/src/m/<class>/<id>.html
 * Add a row when a material is added, or the guard below cannot see it. The sources are
 * gitignored, so this table is the only committed record of them. */
const MATERIAL_KEYS = {
  'fifty-states': ['asknotes', 'askprefs', 'askthreads', 'deck', 'followFocus', 'fsrs', 'mapPrefs', 'regionsDone', 'trapnotes'],
  'periodic':     ['asknotes', 'askprefs', 'askthreads', 'best', 'fsrs', 'setsDone', 'settings', 'started', 'tests', 'trapnotes', 'ui'],
  'fraser12':     ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'mcAttempt', 'mcDraft', 'trapnotes', 'ui'],
  'fraser34':     ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'mcAttempt', 'mcDraft', 'trapnotes', 'ui'],
  'fraserall':    ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'mcAttempt', 'mcDraft', 'trapnotes', 'ui'],
  'fraser5':      ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'mcAttempt', 'mcDraft', 'trapnotes', 'ui'],
  'acct1':        ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'mcAttempt', 'mcDraft', 'trapnotes', 'ui'],
  'apushp12':     ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'apush5saq':    ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'chemunit':     ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'la10crucible': ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'la10crucible34': ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'la10vocab1':   ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'frchateaux':   ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'psychu0':      ['asknotes', 'askprefs', 'askthreads', 'fsrs', 'trapnotes', 'ui'],
  'alg2u1':       ['asknotes', 'askprefs', 'askthreads', 'attempt', 'draft', 'history', 'lastDrill', 'lessons', 'mock', 'mockHistory', 'skills', 'trapnotes', 'ui']
};

/* Newest write wins on purpose, with the reason. Anything else without a rule is a bug: two
 * devices then overwrite each other's copy of it wholesale. */
const DELIBERATE_LAST_WRITE = {
  'alg2u1:draft': 'the answers being typed into the test, { v } with nothing to date it by, emptied on submit: a union would resurrect answers that were just cleared'
};

test('every key every material writes is merged, excluded, or deliberately last-write', () => {
  const unruled = [];
  for (const [ns, keys] of Object.entries(MATERIAL_KEYS)) {
    for (const key of keys) {
      const full = ns + ':' + key;
      if (askExcluded(ns, key)) continue;                 // stays on the device
      if (typeof REG[full] === 'function') continue;      // has a rule
      if (typeof REG['*:' + key] === 'function') continue; // one rule for that key in every namespace
      if (full in DELIBERATE_LAST_WRITE) continue;        // named, with a reason
      unruled.push(full);
    }
  }
  assert.deepEqual(unruled, [], 'these would silently overwrite between devices');
});

test('progress never lives only in a key that stays on the device', () => {
  /* ui is device-local, so a material that keeps marks there must list the fields in
     SYNC_PARTIAL and register the uimarks rule. */
  for (const [ns, fields] of Object.entries(SYNC_PARTIAL)) {
    assert.ok(MATERIAL_KEYS[ns], ns + ' is in SYNC_PARTIAL but not in MATERIAL_KEYS');
    assert.ok(askExcluded(ns, 'ui'), ns + ' partial-syncs ui without excluding it');
    assert.equal(typeof REG[ns + ':uimarks'], 'function', ns + ' has no uimarks rule');
    assert.ok(fields.length, ns + ' lists no fields');
  }
});

test('askprefs: one switch flipped on a phone does not carry its stale copy of the others', () => {
  const a = env({ 'chemunit:askprefs': [{ practice: true, textbook: 'off', effort: 'low' }, 500] });
  const b = env({ 'chemunit:askprefs': [{ practice: false, textbook: 'on', notes: true }, 900] });
  const m = merge(a, b).ns.chemunit.askprefs.value;
  assert.equal(m.notes, true, 'a switch only the newer side knows survives');
  assert.equal(m.effort, 'low', 'a switch only the older side knows is not stripped');
  assert.deepEqual(merge(b, a).ns.chemunit.askprefs.value, m, 'both directions agree');
});

test('mcAttempt: a submitted quiz is not lost to a stale device', () => {
  const rule = makeSittingMerge('at');
  const older = { at: 100, items: ['q1'], v: { q1: 0 } };
  const newer = { at: 900, items: ['q1', 'q2'], v: { q1: 1, q2: 2 } };
  assert.deepEqual(rule(older, newer, 9000, 10), newer, 'the later sitting wins even when the stale device wrote last');
  assert.deepEqual(rule(newer, older, 10, 9000), newer);
  /* Cleared on purpose ("start a fresh quiz") is the one case only the write time can date. */
  assert.equal(rule(null, newer, 9000, 10), null, 'a newer clear wins');
  assert.deepEqual(rule(null, newer, 10, 9000), newer, 'a stale clear does not');
});

test('mcDraft: one sitting answered on two devices keeps every answer', () => {
  const a = { items: ['q1', 'q2', 'q3'], ord: { q1: [0, 1] }, at: 500, v: { q1: 2 } };
  const b = { items: ['q1', 'q2', 'q3'], ord: { q1: [0, 1] }, at: 500, v: { q2: 3 } };
  assert.deepEqual(mergeQuizDraft(a, b, 10, 20).v, { q1: 2, q2: 3 });
  assert.deepEqual(mergeQuizDraft(b, a, 20, 10).v, { q1: 2, q2: 3 });
  /* One question answered on both: the later write's answer. */
  assert.equal(mergeQuizDraft({ ...a, v: { q1: 2 } }, { ...b, v: { q1: 3 } }, 10, 20).v.q1, 3);
  assert.equal(mergeQuizDraft({ ...a, v: { q1: 2 } }, { ...b, v: { q1: 3 } }, 20, 10).v.q1, 2);
  /* A different sitting is a different set of questions: never mix the answers. */
  assert.deepEqual(mergeQuizDraft({ ...a, at: 100 }, { ...b, at: 900 }, 9000, 10).v, { q2: 3 });
});

test('alg2u1 skills: neither device loses its practice', () => {
  const phone = { factor: { r: 5, w: 2, last: 900 }, seq: { r: 1, w: 0, last: 100 } };
  const laptop = { factor: { r: 3, w: 4, last: 500 }, recur: { r: 2, w: 1, last: 700 } };
  const m = mergeSkillCounts(phone, laptop), r = mergeSkillCounts(laptop, phone);
  assert.deepEqual(m, r, 'both directions agree');
  assert.deepEqual(m.factor, { r: 5, w: 4, last: 900 });
  assert.deepEqual(m.seq, { r: 1, w: 0, last: 100 }, 'a skill only one device practised survives');
  assert.deepEqual(m.recur, { r: 2, w: 1, last: 700 });
  assert.equal(REG['alg2u1:skills'], mergeSkillCounts);
  /* The whole map used to be replaced by whichever device wrote last. */
  assert.notDeepEqual(mergeSkillCounts(phone, laptop), laptop);
});

test('alg2u1 history: test results merge by their own stamp, which is at, not ts', () => {
  const rule = makeEventMerge(40, 'at');
  const merged = rule([{ at: 100, pts: 3, max: 10 }], [{ at: 200, pts: 8, max: 10 }]);
  assert.deepEqual(merged.map(x => x.at), [100, 200], 'both sittings kept');
  assert.equal(rule([{ at: 100, pts: 3 }], [{ at: 100, pts: 3 }]).length, 1, 'the same sitting is not doubled');
  assert.equal(REG['alg2u1:history'](  [{ at: 1 }], [{ at: 2 }]).length, 2);
});

/* ---------- asknotes: an edit and a pin have to reach the other device ----------
   The merge used to rebuild every note as { ts, t, del }, so anything else on a note was lost
   on the first sync. Editing a note to something shorter was undone by the stale copy, because
   the longer text won. Both now travel by their own stamp. */
test('asknotes: a later edit wins, however short, and a pin travels both ways', () => {
  const rule = BUILTIN_MERGES['apushp12:asknotes'];
  const phone = [{ ts: 1, t: 'the long original wording of this note', v: 10 }];
  const mac   = [{ ts: 1, t: 'short', v: 20 }];
  for (const [a, b] of [[phone, mac], [mac, phone]]) {
    const m = rule(a, b);
    assert.equal(m.length, 1);
    assert.equal(m[0].t, 'short', 'the later edit wins even when it is shorter');
    assert.equal(m[0].v, 20);
  }
  /* With no stamp at all the old rule still holds, so notes written before this keep working. */
  assert.equal(rule([{ ts: 2, t: 'aa' }], [{ ts: 2, t: 'aaa' }])[0].t, 'aaa');

  /* Pinning, and unpinning, by their own stamp. */
  const pinned = [{ ts: 3, t: 'n', p: true, pv: 5 }];
  const unpin  = [{ ts: 3, t: 'n', p: false, pv: 9 }];
  assert.equal(rule(pinned, [{ ts: 3, t: 'n' }])[0].p, true, 'a pin reaches a device that has none');
  for (const [a, b] of [[pinned, unpin], [unpin, pinned]]) {
    assert.ok(!rule(a, b)[0].p, 'the later change wins, so unpinning travels');
  }
  /* A deleted note is still a tombstone, whatever else was on it. */
  const dead = rule([{ ts: 4, t: 'n', p: true, pv: 1 }], [{ ts: 4, t: '', del: true }]);
  assert.deepEqual(dead, [{ ts: 4, t: '', del: true }]);
});


/* ---------- *:askthreads: Ask chat history ---------- */
{
  const { mergeAskThreads } = require('../assets/sync.js');
  const chat = (id, ts, extra) => Object.assign({ id, ts, title: 'chat ' + id, msgs: [{ role: 'user', text: 'q ' + id }, { role: 'assistant', text: 'a ' + id }] }, extra || {});

  test('askthreads: one rule for every namespace, reached through the wildcard', () => {
    assert.equal(REG['*:askthreads'], mergeAskThreads);
    const a = { v: 1, ns: { fraser5: { askthreads: { value: [chat('ask-1', 10)], mtime: 900 } } } };
    const b = { v: 1, ns: { fraser5: { askthreads: { value: [chat('ask-2', 20)], mtime: 100 } } } };
    const ids = mergeEnvelopes(a, b).merged.ns.fraser5.askthreads.value.map(t => t.id);
    assert.deepEqual(ids, ['ask-1', 'ask-2'], 'the older envelope loses no chat, which the default rule did');
  });

  test('askthreads: the later write supplies the conversation, whole', () => {
    const old = chat('ask-1', 10), now = chat('ask-1', 50, { msgs: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }, { role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' }] });
    assert.equal(mergeAskThreads([old], [now])[0].msgs.length, 4);
    assert.equal(mergeAskThreads([now], [old])[0].msgs.length, 4);
  });

  test('askthreads: a rename and a pin survive a later message from the other device', () => {
    const renamed = chat('ask-1', 10, { title: 'Stamp Act notes', tv: 40, p: 1, pv: 41 });
    const later = chat('ask-1', 90);
    const out = mergeAskThreads([renamed], [later])[0];
    assert.equal(out.title, 'Stamp Act notes'); assert.equal(out.tv, 40);
    assert.equal(out.p, 1); assert.equal(out.ts, 90);
    const unpinned = chat('ask-1', 20, { pv: 99 });
    assert.equal(mergeAskThreads([renamed], [unpinned])[0].p, undefined, 'the later pin decision wins, and it was to unpin');
  });

  test('askthreads: a delete on either side wins and the tombstone keeps no text', () => {
    const out = mergeAskThreads([chat('ask-1', 10)], [{ id: 'ask-1', del: true, ts: 5 }]);
    assert.deepEqual(out, [{ id: 'ask-1', del: true, ts: 5 }]);
    assert.deepEqual(mergeAskThreads([{ id: 'ask-1', del: true, ts: 5 }], [chat('ask-1', 999)]), out, 'even against a newer copy');
  });

  test('askthreads: pinned first, 24 live at most, and under the byte cap', () => {
    const many = []; for (let i = 0; i < 40; i++) many.push(chat('ask-' + String(i).padStart(2, '0'), i + 1));
    many[0].p = 1; many[0].pv = 1;
    const out = mergeAskThreads(many, []);
    assert.equal(out.length, 24);
    assert.ok(out.some(t => t.id === 'ask-00'), 'the pinned chat is the oldest and is still here');
    assert.ok(!out.some(t => t.id === 'ask-01'), 'the oldest unpinned went');
    const fat = []; for (let i = 0; i < 24; i++) fat.push(chat('big-' + i, i + 1, { msgs: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'x'.repeat(6000) }] }));
    assert.ok(JSON.stringify(mergeAskThreads(fat, [])).length <= 70000 + 8000, 'held near the cap');
  });

  test('askthreads: order independent, idempotent, and the inputs are never mutated', () => {
    const a = [chat('ask-1', 10, { title: 'A', tv: 5 }), chat('ask-2', 30), { id: 'ask-9', del: true, ts: 3 }];
    const b = [chat('ask-1', 20, { title: 'B', tv: 5 }), chat('ask-3', 5, { p: 1, pv: 2 })];
    const fa = JSON.stringify(a), fb = JSON.stringify(b);
    const ab = mergeAskThreads(a, b), ba = mergeAskThreads(b, a);
    assert.deepEqual(ab, ba);
    assert.deepEqual(mergeAskThreads(ab, ab), ab);
    assert.deepEqual(mergeAskThreads(ab, a), ab);
    assert.equal(JSON.stringify(a), fa); assert.equal(JSON.stringify(b), fb);
    assert.deepEqual(mergeAskThreads(null, 'junk'), []);
  });
}

test('alg2u1 lessons: a lesson finished on one device stays finished on the other', () => {
  assert.equal(REG['alg2u1:lessons'], mergeMarks);
  const m = REG['alg2u1:lessons']({ a: 1, b: 5 }, { b: 9, c: 2 });
  assert.deepEqual(m, { a: 1, b: 9, c: 2 });
});
