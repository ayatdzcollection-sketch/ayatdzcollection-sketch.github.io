/* StudyStore: shared local-first storage + sync for every Study Hub material.
 *
 * Load it before your material's own script:
 *     <script src="../../assets/sync.js"></script>
 *
 * Local-first: every write lands in localStorage synchronously. Supabase is a background
 * replica, never the source of truth, and the UI never waits on it.
 *
 * This file is a classic script in the browser and a CommonJS module under Node (the pure
 * merge core is exported for tests). Section A touches no browser globals for that reason.
 */
(function () {
'use strict';

/* ============================================================================
 * CONFIG: the only lines you edit to turn sync on.
 * Paste your Supabase project URL and anon (public) key. Leave empty to run
 * local-only: everything works except pairing sync.
 * NEVER put the service_role key here. This file is public.
 * ========================================================================== */
var SUPABASE_URL      = 'https://gyfqhkhgosjpyvatffbi.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb';
/* ======================================================================== */

var STORE_PREFIX = 'studyhub:';
var META_KEY     = 'studyhub:meta';
var DIRTY_KEY    = 'studyhub:dirty';
var ENVELOPE_V   = 1;
var PUSH_THROTTLE_MS = 12000;
var MAX_SYNC_ATTEMPTS = 3;
var KEEPALIVE_LIMIT = 60000;   // browsers cap keepalive bodies at ~64KB

/* Keys that stay on this device and never enter a sync or export envelope.
 * 'deck' is dead Leitner data read once at boot for migration.
 * 'followFocus' and 'mapPrefs' are view preferences: a phone and a laptop reasonably want
 * different zoom behaviour, and carrying one device's choice to the other is a nuisance.
 * 'ui' is which tab was last open, not progress, and reasonably different per device.
 * 'recent' is browser-history-like: meaningful per device, noise across devices. */
var SYNC_EXCLUDE = {
  'fifty-states': ['deck', 'followFocus', 'mapPrefs'],
  'periodic': ['ui'],
  'fraser12': ['ui'],
  'fraser34': ['ui'],
  'fraserall': ['ui'],
  'fraser5': ['ui'],
  'chemunit': ['ui'],
  'alg2u1': ['ui'],
  'acct1': ['ui'],
  'la10crucible': ['ui'],
  'la10crucible34': ['ui'],
  'apushp12': ['ui'],
  'apush5saq': ['ui'],
  'psychu0': ['ui'],
  'la10vocab1': ['ui'],
  'frchateaux': ['ui'],
  /* 'telemetryQueue' and 'installId' are per device by definition: copying a queue between
   * devices would send the same reviews twice, and the install id is what keeps one
   * device's stream separable from another's without naming anybody. 'installMeta' (how the
   * id was found), 'visitQueue' (the visit diary) and 'seen' (per material counts for the
   * rough start suggestion and the quiz check in) are the same kind of thing. 'person' is
   * NOT listed: it is meant to travel, so paired devices share it. The 'telemetry'
   * preference itself DOES sync, because a decision about your own data should hold
   * everywhere you study rather than needing to be made again on each device. */
  'hub': ['recent', 'telemetryQueue', 'installId', 'installMeta', 'visitQueue', 'seen', 'telemetryLocal']
};

/* Whole namespaces that never leave the device, whatever the key. 'auth' holds the session
 * token, the role, the cached decryption keys and the cached catalog: credentials and
 * server state, not progress. They share the store prefix, so without this they were swept
 * into the envelope like everything else. That carried an owner sign-in onto every paired
 * device, parked material keys in the sync row, and undid every sign-out: the next merge
 * found the keys on the server and put them back. */
var SYNC_EXCLUDE_NS = { 'auth': true };

/* Progress that lives inside a device-only key. 'ui' stays on the device because it is mostly
 * which tab was open, but three materials also keep real progress in it: the Crucible stretches
 * walked, the APUSH must knows marked, the vocabulary words met. Those fields alone travel,
 * under the virtual key 'uimarks', which exists in the envelope and never in localStorage: it is
 * read out of 'ui' when the envelope is built and written back into 'ui' when one is applied. */
var SYNC_PARTIAL_KEY = 'uimarks';
var SYNC_PARTIAL = {
  'la10crucible': ['walked'],
  /* the Crucible acts 3 and 4 teaches each part before it tests it: which parts have been
   * read is progress, and it lives in ui beside which stretches have been walked. */
  'la10crucible34': ['walked', 'read'],
  'apushp12': ['mk'],
  /* the chapter 5 short answer material keeps its must knows and the lessons done ({ f, done }) */
  'apush5saq': ['mk', 'les'],
  'la10vocab1': ['intro', 'ready'],
  'fraser5': ['mk', 'tfb']
};

/* Captured at parse time: document.currentScript is only valid while this script runs. */
var SCRIPT_URL = (typeof document !== 'undefined' && document.currentScript)
  ? document.currentScript.src
  : null;

/* ============================================================================
 * SECTION A: pure core. No window, no localStorage, no navigator, no fetch.
 * Everything here is unit-testable under plain Node.
 * ========================================================================== */

var CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32: no I, L, O, U
var CODE_LEN = 12;                                        // 12 symbols x 5 bits = 60 bits

/* Accepts what a human types: any case, dashes or spaces anywhere, and the four
 * ambiguous letters the alphabet never emits (so any of them is a misread). */
function normalizeCode(input) {
  if (typeof input !== 'string') throw new Error('Enter a pairing code.');
  var s = input.toUpperCase().replace(/[\s\-]/g, '');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === 'O') c = '0';
    else if (c === 'I' || c === 'L') c = '1';
    else if (c === 'U') c = 'V';
    out += c;
  }
  if (out.length !== CODE_LEN) {
    throw new Error('A pairing code is ' + CODE_LEN + ' characters (like K7Q2-9MXR-4B8T).');
  }
  for (var j = 0; j < out.length; j++) {
    if (CODE_ALPHABET.indexOf(out.charAt(j)) === -1) {
      throw new Error('That code contains a character we do not use: "' + out.charAt(j) + '".');
    }
  }
  return out;
}

function formatCode(code) {
  return code.replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');
}

/* Key-order-independent on purpose. Postgres stores jsonb with its own key ordering, so
   a record comes back spelled differently than it went in. Comparing raw JSON would call
   that a change on every sync, and would let key order decide merge tie-breaks. */
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  var keys = Object.keys(v).sort();
  return '{' + keys.map(function (k) {
    return JSON.stringify(k) + ':' + canonicalJson(v[k]);
  }).join(',') + '}';
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/* Default rule for any key without a registered merge: newest write wins.
 * An exact mtime tie falls back to a lexicographic comparison purely so the result is
 * deterministic and side-symmetric: merge(a,b) and merge(b,a) must agree, or repeated
 * syncs between two devices would never settle. */
function defaultMerge(aVal, bVal, aM, bM) {
  if (aM > bM) return aVal;
  if (bM > aM) return bVal;
  return canonicalJson(aVal) >= canonicalJson(bVal) ? aVal : bVal;
}

/* FSRS state records are only coherent as a set: stability, difficulty, last, reps and
 * lapses are computed together from one review. Merging them field-by-field would invent
 * a review that never happened, so the whole record travels or it does not. */
function pickStateRecord(a, b, aM, bM) {
  var aLast = (a && typeof a.last === 'number') ? a.last : 0;
  var bLast = (b && typeof b.last === 'number') ? b.last : 0;
  if (aLast > bLast) return a;
  if (bLast > aLast) return b;
  var aReps = (a && typeof a.reps === 'number') ? a.reps : 0;
  var bReps = (b && typeof b.reps === 'number') ? b.reps : 0;
  if (aReps > bReps) return a;
  if (bReps > aReps) return b;
  /* Same review on both sides, yet the records differ: something that is not a review was
   * changed (a star set or cleared on a notecard). The side written later carries it. Without
   * this the winner was decided by spelling, so a star could not be taken off once synced. */
  if (typeof aM === 'number' && typeof bM === 'number' && aM !== bM) return aM > bM ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

/* Event logs all merge the same way: concatenate, dedupe by timestamp, keep the newest N.
 * The cap is a parameter because the two histories want different depths. Practice runs
 * share one 20-slot log, but graded tests are rarer and worth more, so they keep 40: a
 * week of drilling should not be able to evict a test result. */
function makeEventMerge(cap, stamp) {
  var F = stamp || 'ts';
  return function (aEx, bEx) {
  var all = [].concat(Array.isArray(aEx) ? aEx : [], Array.isArray(bEx) ? bEx : []);
  var byTs = {};
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (!e || typeof e[F] === 'undefined') continue;
    var k = String(e[F]);
    var prev = byTs[k];
    if (!prev) { byTs[k] = e; continue; }
    // Same timestamp from both sides: prefer a pass, then break ties deterministically.
    if (!prev.exact && e.exact) byTs[k] = e;
    else if (prev.exact === e.exact && canonicalJson(e) > canonicalJson(prev)) byTs[k] = e;
  }
  var out = [];
  for (var key in byTs) if (Object.prototype.hasOwnProperty.call(byTs, key)) out.push(byTs[key]);
  out.sort(function (x, y) { return x[F] - y[F]; });
  return out.slice(-cap);
  };
}
var mergeExams = makeEventMerge(20);

/* Every spaced-repetition material shares one shape: a map of records keyed by whatever
   it drills, plus exams and a quiz date. Only the name of that map differs, so the rule
   is written once and bound to each material's field. */
function makeFsrsMerge(mapField, extras, examCap) {
  var examMerge = examCap ? makeEventMerge(examCap) : mergeExams;
  return function (aVal, bVal, aM, bM) {
    var a = aVal && typeof aVal === 'object' ? aVal : {};
    var b = bVal && typeof bVal === 'object' ? bVal : {};
    var aMap = a[mapField] && typeof a[mapField] === 'object' ? a[mapField] : {};
    var bMap = b[mapField] && typeof b[mapField] === 'object' ? b[mapField] : {};

    var out = {};
    var name;
    for (name in aMap) if (Object.prototype.hasOwnProperty.call(aMap, name)) out[name] = aMap[name];
    for (name in bMap) {
      if (!Object.prototype.hasOwnProperty.call(bMap, name)) continue;
      out[name] = Object.prototype.hasOwnProperty.call(aMap, name)
        ? pickStateRecord(aMap[name], bMap[name], aM, bM)
        : bMap[name];
    }

    var quizDate;
    if (aM > bM) quizDate = a.quizDate;
    else if (bM > aM) quizDate = b.quizDate;
    else if (a.quizDate && !b.quizDate) quizDate = a.quizDate;
    else if (b.quizDate && !a.quizDate) quizDate = b.quizDate;
    else quizDate = (String(a.quizDate) >= String(b.quizDate)) ? a.quizDate : b.quizDate;

    var merged = { quizDate: typeof quizDate === 'undefined' ? null : quizDate,
                   exams: examMerge(a.exams, b.exams) };
    merged[mapField] = out;

    /* Anything else a material keeps beside its cards. This rule used to rebuild the value from
     * the three fields it knew, so every other field was deleted by the first merge after it was
     * written, on the device that wrote it as well: the chemistry unit lost its list of missed
     * problems, its start date and its last worked time that way, every sync. A field with a rule
     * in extras is merged by it; any other field is kept, from the only side that has it or
     * else from the side written later. */
    var seen = {}, f;
    for (f in a) if (Object.prototype.hasOwnProperty.call(a, f)) seen[f] = true;
    for (f in b) if (Object.prototype.hasOwnProperty.call(b, f)) seen[f] = true;
    for (f in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, f)) continue;
      if (f === mapField || f === 'quizDate' || f === 'exams' || f === '__proto__') continue;
      var inA = Object.prototype.hasOwnProperty.call(a, f), inB = Object.prototype.hasOwnProperty.call(b, f);
      if (extras && typeof extras[f] === 'function') merged[f] = extras[f](inA ? a[f] : undefined, inB ? b[f] : undefined, aM, bM);
      else if (!inB) merged[f] = a[f];
      else if (!inA) merged[f] = b[f];
      else merged[f] = defaultMerge(a[f], b[f], aM, bM);
    }
    return merged;
  };
}

/* Rules for the extra fields. A missed list is a log kept newest first: union by ts, newest kept.
 * A start date is the earliest day either device saw. A last worked time is the latest. */
function makeNewestFirstLog(cap) {
  var inner = makeEventMerge(cap);
  return function (aArr, bArr) { return inner(aArr, bArr).reverse(); };
}
function mergeEarliestDay(aVal, bVal) {
  var a = typeof aVal === 'string' && aVal ? aVal : null, b = typeof bVal === 'string' && bVal ? bVal : null;
  if (!a || !b) return a || b || null;
  return a <= b ? a : b;
}
function mergeLatestNumber(aVal, bVal) {
  var a = typeof aVal === 'number' && isFinite(aVal) ? aVal : 0, b = typeof bVal === 'number' && isFinite(bVal) ? bVal : 0;
  return Math.max(a, b);
}

var mergeFsrsValue  = makeFsrsMerge('states');   // fifty-states
var mergeCardsFsrs  = makeFsrsMerge('cards');    // periodic table, both Fraser reading quizzes
/* The chemistry unit keeps 30 problem sets, the 40 newest missed problems, the day it was
 * started, when it was last worked and which topics it has taught, all inside its fsrs value. */
var mergeChemUnitFsrs = makeFsrsMerge('cards', {
  missed: makeNewestFirstLog(40), start: mergeEarliestDay, lastWorked: mergeLatestNumber,
  taught: mergeMarks,                // topics whose rule card the feed has shown: a union
  lessons: mergeMarks                // Learn tab lessons finished (2026-09-21): a union, like taught
}, 30);

function mergeRegionsDone(aVal, bVal) {
  var seen = {};
  var push = function (arr) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) seen[String(arr[i])] = true;
  };
  push(aVal); push(bVal);
  var out = [];
  for (var k in seen) if (Object.prototype.hasOwnProperty.call(seen, k)) out.push(k);
  out.sort();   // sorted so equality checks are trivial; the quiz only ever calls includes()
  return out;
}

/* mergeRegionsDone stringifies its members, which is right for ids like "r3" and wrong for
 * atomic numbers: it would sort 10 before 2 and hand back the string "10" where the quiz
 * looks up the number 10, so every element would read as unlearned. Same union, kept
 * numeric, non-numbers dropped rather than coerced. */
function mergeNumberSet(aVal, bVal) {
  var seen = {};
  var push = function (arr) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) {
      /* Number(null) is 0 and Number('') is 0, so a null in a half-migrated list would
       * quietly become "element 0". Only numbers and non-blank strings are considered. */
      var raw = arr[i];
      if (typeof raw !== 'number' && typeof raw !== 'string') continue;
      if (typeof raw === 'string' && raw.trim() === '') continue;
      var v = Number(raw);
      if (isFinite(v)) seen[v] = true;
    }
  };
  push(aVal); push(bVal);
  var out = [];
  for (var k in seen) if (Object.prototype.hasOwnProperty.call(seen, k)) out.push(Number(k));
  out.sort(function (x, y) { return x - y; });
  return out;
}

/* Settings are a bag of independent switches, not one document. Newest-write-wins fails
 * quietly and badly here: a phone that has been closed a week opens, the user nudges one
 * slider, and the phone pushes its whole object, carrying its month-old scope back over
 * the laptop's. Nothing errors; the user just finds settings reverting.
 *
 * So each field carries its own timestamp in the 'at' map and each field is decided on its
 * own. A field only one side knows about survives untouched, which means an older build can
 * never strip a setting a newer one added. */
function mergeSettings(aVal, bVal, aM, bM) {
  var a = aVal && typeof aVal === 'object' ? aVal : {};
  var b = bVal && typeof bVal === 'object' ? bVal : {};
  var aAt = (a.at && typeof a.at === 'object') ? a.at : {};
  var bAt = (b.at && typeof b.at === 'object') ? b.at : {};
  var aEnv = typeof aM === 'number' ? aM : 0;
  var bEnv = typeof bM === 'number' ? bM : 0;

  var names = {}, f;
  for (f in a) if (Object.prototype.hasOwnProperty.call(a, f) && f !== 'at' && f !== 'v') names[f] = true;
  for (f in b) if (Object.prototype.hasOwnProperty.call(b, f) && f !== 'at' && f !== 'v') names[f] = true;

  var out = {}, at = {};
  for (f in names) {
    if (!Object.prototype.hasOwnProperty.call(names, f)) continue;
    var inA = Object.prototype.hasOwnProperty.call(a, f);
    var inB = Object.prototype.hasOwnProperty.call(b, f);
    /* An object written before per-field stamps existed has no 'at', so fall back to the
     * envelope mtime, the best evidence available for when it was last touched. */
    var aT = typeof aAt[f] === 'number' ? aAt[f] : aEnv;
    var bT = typeof bAt[f] === 'number' ? bAt[f] : bEnv;
    if (!inB) { out[f] = a[f]; at[f] = aT; continue; }
    if (!inA) { out[f] = b[f]; at[f] = bT; continue; }
    if (aT > bT) out[f] = a[f];
    else if (bT > aT) out[f] = b[f];
    /* Exact tie: the same rule defaultMerge uses, so merge(a,b) and merge(b,a) agree and
     * repeated syncs between two devices settle instead of oscillating forever. */
    else out[f] = canonicalJson(a[f]) >= canonicalJson(b[f]) ? a[f] : b[f];
    at[f] = aT > bT ? aT : bT;
  }
  out.v = Math.max(typeof a.v === 'number' ? a.v : 0, typeof b.v === 'number' ? b.v : 0);
  out.at = at;
  return out;
}

/* Notes kept beside Ask in the APUSH material: [{ ts, t, del }]. ts is the creation time and
 * the note's identity, t its text (at most 300 characters), del a tombstone. Newest write
 * wins would lose a note written on the phone to one written on the laptop, and would bring
 * a deleted note back from whichever device had not heard about the delete, so:
 *   - union by ts;
 *   - a note deleted on either side stays deleted: the tombstone is kept, its text dropped,
 *     so the delete keeps travelling to devices that still hold the note;
 *   - the same ts with different text keeps whichever carries the later v (the edit stamp), so
 *     an edit that shortens a note is not undone by a stale copy on the other device; with no
 *     stamp on either side it keeps the longer (equal lengths: the greater string, so both
 *     merge directions agree);
 *   - pinned travels the same way, by its own stamp pv, so unpinning reaches the other device;
 *   - sorted by ts, at most 80 kept: the oldest tombstones go first, then the oldest notes.
 * Entries without a finite numeric ts are dropped, and neither input is touched. A tombstone
 * comes out as { ts, t: '', del: true } so every entry has a string t. */
var ASK_NOTES_CAP = 80;
var ASK_NOTE_MAX = 300;

function mergeAskNotes(aVal, bVal) {
  var byTs = Object.create(null);
  var take = function (arr) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n || typeof n !== 'object' || typeof n.ts !== 'number' || !isFinite(n.ts)) continue;
      var k = String(n.ts);
      var t = typeof n.t === 'string' ? n.t.slice(0, ASK_NOTE_MAX) : '';
      var del = n.del === true;
      var v = typeof n.v === 'number' && isFinite(n.v) ? n.v : 0;
      var p = n.p === true;
      var pv = typeof n.pv === 'number' && isFinite(n.pv) ? n.pv : 0;
      var prev = byTs[k];
      if (!prev) { byTs[k] = { ts: n.ts, t: t, del: del, v: v, p: p, pv: pv }; continue; }
      if (del) prev.del = true;
      if (v !== prev.v) { if (v > prev.v) { prev.t = t; prev.v = v; } }
      else if (t.length > prev.t.length || (t.length === prev.t.length && t > prev.t)) prev.t = t;
      if (pv > prev.pv) { prev.p = p; prev.pv = pv; }
    }
  };
  take(aVal);
  take(bVal);

  var notes = [], dead = [];
  for (var k in byTs) {
    var e = byTs[k];
    if (e.del) dead.push({ ts: e.ts, t: '', del: true });
    else {
      var out = { ts: e.ts, t: e.t };
      if (e.v) out.v = e.v;
      if (e.p) out.p = true;
      if (e.pv) out.pv = e.pv;
      notes.push(out);
    }
  }
  var byTime = function (x, y) { return x.ts - y.ts; };
  notes.sort(byTime);
  dead.sort(byTime);

  var over = notes.length + dead.length - ASK_NOTES_CAP;
  if (over > 0) {
    var drop = Math.min(over, dead.length);
    dead = dead.slice(drop);
    over -= drop;
  }
  if (over > 0) notes = notes.slice(over);

  return notes.concat(dead).sort(byTime);
}

/* Trap notes kept beside Ask (the 'trap' feature, migration 0025): { <card id>: { ts, t, w } },
 * one per card, written once after the single AI call that card is ever allowed. t is the note
 * (at most 400 characters), ts when it was written, w the option it explains. { ts, none: true }
 * marks a call that was paid for but gave no usable note, so no device pays for that card
 * again. Newest write wins would drop a note written on the other device, so:
 *   - union by card id;
 *   - a note beats a marker; two notes for one card (both devices asked before a sync) keep the
 *     earlier, then the longer, then the greater string, so both merge directions agree;
 *   - at most 500 cards: the oldest markers go first, then the oldest notes.
 * Entries without a finite numeric ts and ids that are not plain card ids are dropped, entries
 * are copied, and neither input is touched. Keys come out sorted. */
var TRAP_NOTES_CAP = 500;
var TRAP_NOTE_MAX = 400;
var TRAP_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function cleanTrapEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.ts !== 'number' || !isFinite(e.ts)) return null;
  var t = typeof e.t === 'string' ? e.t.slice(0, TRAP_NOTE_MAX) : '';
  var out = { ts: e.ts };
  if (t && e.none !== true) out.t = t; else out.none = true;
  if (typeof e.w === 'number' && e.w >= 0 && e.w < 10 && Math.floor(e.w) === e.w) out.w = e.w;
  return out;
}

function betterTrap(a, b) {
  if (!!a.t !== !!b.t) return a.t ? a : b;
  if (a.ts !== b.ts) return a.ts < b.ts ? a : b;
  var at = a.t || '', bt = b.t || '';
  if (at.length !== bt.length) return at.length > bt.length ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

function mergeTrapNotes(aVal, bVal) {
  var byId = Object.create(null);
  var take = function (m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    for (var id in m) {
      if (!Object.prototype.hasOwnProperty.call(m, id) || id === '__proto__' || !TRAP_ID_RE.test(id)) continue;
      var e = cleanTrapEntry(m[id]);
      if (!e) continue;
      byId[id] = byId[id] ? betterTrap(byId[id], e) : e;
    }
  };
  take(aVal);
  take(bVal);

  var ids = Object.keys(byId);
  var over = ids.length - TRAP_NOTES_CAP;
  if (over > 0) {
    ids.sort(function (x, y) {
      var ex = byId[x], ey = byId[y];
      if (!!ex.t !== !!ey.t) return ex.t ? 1 : -1;
      if (ex.ts !== ey.ts) return ex.ts - ey.ts;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (var i = 0; i < over; i++) delete byId[ids[i]];
  }
  var out = {};
  Object.keys(byId).sort().forEach(function (id) { out[id] = byId[id]; });
  return out;
}

/* One sitting of a quiz or test: { at, v, ... } where at is when it was started or submitted,
 * or null once it has been cleared. Newest write wins loses a submitted quiz to a stale device's
 * copy of the same key, so the sitting with the later 'at' wins instead. A side that is null has
 * cleared it on purpose ("start a fresh quiz"), which only its own envelope time can date, so
 * that case alone falls back to the newest write. */
function makeSittingMerge(stampField) {
  return function (aVal, bVal, aM, bM) {
    var isObj = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
    var aAt = isObj(aVal) && typeof aVal[stampField] === 'number' ? aVal[stampField] : null;
    var bAt = isObj(bVal) && typeof bVal[stampField] === 'number' ? bVal[stampField] : null;
    if (aAt === null && bAt === null) return defaultMerge(aVal, bVal, aM, bM);
    if (aAt === null) return (aM || 0) > (bM || 0) ? aVal : bVal;
    if (bAt === null) return (bM || 0) > (aM || 0) ? bVal : aVal;
    if (aAt !== bAt) return aAt > bAt ? aVal : bVal;
    return defaultMerge(aVal, bVal, aM, bM);
  };
}

/* The quiz in progress: { items, v, ord, at }. A different 'at' is a different sitting, so the
 * later one wins whole. The same 'at' is one sitting answered on two devices: every question
 * either device answered is kept, and a question both answered takes the later write's answer.
 * Answers are never carried across sittings, where they would belong to different questions. */
function mergeQuizDraft(aVal, bVal, aM, bM) {
  var isObj = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
  if (!isObj(aVal) || !isObj(bVal)) return defaultMerge(aVal, bVal, aM, bM);
  var aAt = typeof aVal.at === 'number' ? aVal.at : 0, bAt = typeof bVal.at === 'number' ? bVal.at : 0;
  if (aAt !== bAt) return aAt > bAt ? aVal : bVal;
  var newer = (bM || 0) > (aM || 0) ? bVal : aVal;
  var out = {}, k;
  for (k in aVal) if (Object.prototype.hasOwnProperty.call(aVal, k) && k !== '__proto__') out[k] = aVal[k];
  for (k in bVal) if (Object.prototype.hasOwnProperty.call(bVal, k) && k !== '__proto__' && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = bVal[k];
  var av = isObj(aVal.v) ? aVal.v : {}, bv = isObj(bVal.v) ? bVal.v : {}, v = {};
  for (k in av) if (Object.prototype.hasOwnProperty.call(av, k) && k !== '__proto__') v[k] = av[k];
  for (k in bv) {
    if (!Object.prototype.hasOwnProperty.call(bv, k) || k === '__proto__') continue;
    v[k] = Object.prototype.hasOwnProperty.call(av, k) ? (newer === bVal ? bv[k] : av[k]) : bv[k];
  }
  out.v = v;
  return out;
}

/* Algebra 2 counts practice per skill rather than scheduling cards: { skill: { r, w, last } }.
 * Newest write wins threw away a whole device's practice. Each count only ever goes up on the
 * device holding it, so the larger of the two is kept. Two devices that both practised since
 * their last sync undercount by the smaller run, which is the honest floor: no practice is
 * invented and none is thrown away. */
function mergeSkillCounts(aVal, bVal) {
  var isObj = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
  if (!isObj(aVal)) return isObj(bVal) ? bVal : (aVal === null || typeof aVal === 'undefined' ? (isObj(bVal) ? bVal : {}) : aVal);
  if (!isObj(bVal)) return aVal;
  var out = {}, k;
  var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; };
  for (k in aVal) if (Object.prototype.hasOwnProperty.call(aVal, k) && k !== '__proto__') out[k] = aVal[k];
  for (k in bVal) {
    if (!Object.prototype.hasOwnProperty.call(bVal, k) || k === '__proto__') continue;
    var a = out[k], b = bVal[k];
    if (!isObj(a)) { out[k] = b; continue; }
    if (!isObj(b)) continue;
    var m = {}, f;
    for (f in a) if (Object.prototype.hasOwnProperty.call(a, f) && f !== '__proto__') m[f] = a[f];
    for (f in b) if (Object.prototype.hasOwnProperty.call(b, f) && f !== '__proto__' && !Object.prototype.hasOwnProperty.call(m, f)) m[f] = b[f];
    m.r = Math.max(num(a.r), num(b.r));
    m.w = Math.max(num(a.w), num(b.w));
    if (typeof a.last === 'number' || typeof b.last === 'number') m.last = Math.max(num(a.last), num(b.last));
    out[k] = m;
  }
  return out;
}

/* Marks are maps, sometimes nested ({ section: { index: 1 } }, { word: timestamp }). Union all
 * the way down. Where both sides hold a leaf: two timestamps keep the later, anything else is
 * taken from the side written later, a tie by spelling so both merge directions agree. */
function mergeMarks(aVal, bVal, aM, bM) {
  var isMap = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
  if (!isMap(aVal) || !isMap(bVal)) {
    if (typeof aVal === 'undefined' || aVal === null) return typeof bVal === 'undefined' ? null : bVal;
    if (typeof bVal === 'undefined' || bVal === null) return aVal;
    if (typeof aVal === 'number' && typeof bVal === 'number' && aVal > 1e11 && bVal > 1e11) return Math.max(aVal, bVal);
    return defaultMerge(aVal, bVal, aM || 0, bM || 0);
  }
  var out = {}, k;
  for (k in aVal) if (Object.prototype.hasOwnProperty.call(aVal, k) && k !== '__proto__') out[k] = aVal[k];
  for (k in bVal) {
    if (!Object.prototype.hasOwnProperty.call(bVal, k) || k === '__proto__') continue;
    out[k] = Object.prototype.hasOwnProperty.call(aVal, k) ? mergeMarks(aVal[k], bVal[k], aM, bM) : bVal[k];
  }
  return out;
}

/* Material-specific merges that the HUB also needs live here rather than being registered
 * by the material. The hub merges on load, on visibility and during import preview, all
 * while the quiz page may be closed. See README, "Adding a material". */
/* Ask chat history, key 'askthreads' in every material that has Ask.
 *
 * It was never registered and never excluded, so until 2026-09-20 it travelled on the default
 * rule: whichever device wrote last replaced the other's whole history. The kit's own comment
 * said it never left the device. Both were wrong in a way nobody would notice until a chat
 * went missing.
 *
 * A row is one conversation: { id, ts, title, tv, p, pv, msgs, ... }. Rows are joined by id.
 *   - The row written later (ts) supplies the conversation itself: msgs, quote, rules, ctx,
 *     pending, recovered. A conversation is only coherent whole, like an fsrs record.
 *   - A rename is a version (tv), so a title given on one device is not undone by the other
 *     device saving a new message under the old name. Same for a pin (pv).
 *   - A delete on either side wins and keeps no text: { id, del: true, ts }.
 *   - Pinned first, then newest, 24 live rows and 40 tombstones at most, and the whole value is
 *     held under ASK_THREADS_BYTES by dropping the oldest unpinned rows, because the envelope
 *     every material shares is limited to one megabyte.
 * Pure, order independent, idempotent; inputs are never mutated. */
var ASK_THREADS_MAX = 24, ASK_THREADS_TOMBS = 40, ASK_THREADS_BYTES = 70000;
function mergeAskThreads(aVal, bVal) {
  var byId = Object.create(null);
  var num = function (x) { return typeof x === 'number' && isFinite(x) ? x : 0; };
  var take = function (arr) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) continue;
      var prev = byId[t.id];
      if (!prev) { byId[t.id] = { row: t, del: t.del === true, delTs: t.del === true ? num(t.ts) : 0 }; prev = byId[t.id]; prev.title = t; prev.pin = t; continue; }
      if (t.del === true) { prev.del = true; prev.delTs = Math.max(prev.delTs, num(t.ts)); }
      var better = num(t.ts) > num(prev.row.ts) || (num(t.ts) === num(prev.row.ts) && canonicalJson(t) > canonicalJson(prev.row));
      if (better) prev.row = t;
      if (num(t.tv) > num(prev.title.tv) || (num(t.tv) === num(prev.title.tv) && num(t.tv) > 0 && String(t.title || '') > String(prev.title.title || ''))) prev.title = t;
      if (num(t.pv) > num(prev.pin.pv) || (num(t.pv) === num(prev.pin.pv) && num(t.pv) > 0 && !!t.p && !prev.pin.p)) prev.pin = t;
    }
  };
  take(aVal);
  take(bVal);

  var live = [], dead = [];
  for (var id in byId) {
    var e = byId[id];
    if (e.del) { dead.push({ id: id, del: true, ts: e.delTs }); continue; }
    var out = {};
    for (var f in e.row) if (Object.prototype.hasOwnProperty.call(e.row, f)) out[f] = e.row[f];
    /* With no rename on either side the title belongs to the conversation that won. */
    if (num(e.title.tv) > 0) { out.title = e.title.title; out.tv = e.title.tv; }
    if (num(e.pin.pv) > 0) { out.pv = e.pin.pv; if (e.pin.p) out.p = e.pin.p; else delete out.p; }
    live.push(out);
  }
  var newest = function (x, y) { return num(y.ts) - num(x.ts) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0); };
  var pins = live.filter(function (t) { return !!t.p; }).sort(newest);
  var rest = live.filter(function (t) { return !t.p; }).sort(newest);
  rest = rest.slice(0, Math.max(0, ASK_THREADS_MAX - pins.length));
  while (rest.length > 2 && JSON.stringify(pins.concat(rest)).length > ASK_THREADS_BYTES) rest.pop();
  dead.sort(newest);
  var all = pins.concat(rest).concat(dead.slice(0, ASK_THREADS_TOMBS));
  all.sort(function (x, y) { return num(x.ts) - num(y.ts) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0); });
  return all;
}

/* A rule that holds for one key in every namespace is written once as '*:<key>'. A namespace's
 * own rule still comes first. */
var BUILTIN_MERGES = {
  '*:askthreads': mergeAskThreads,
  'fifty-states:fsrs': mergeFsrsValue,
  'fifty-states:regionsDone': mergeRegionsDone,
  'periodic:fsrs': mergeCardsFsrs,
  /* The Fraser reading quiz schedules both its quiz questions and its names, and stores
   * them in the same { cards, quizDate, exams } shape, so it reuses the rule rather than
   * defining a third one. Without this entry a phone's reviews would be overwritten
   * wholesale by whichever device wrote last. */
  'fraser12:fsrs': mergeCardsFsrs,
  'fraser34:fsrs': mergeCardsFsrs,
  'fraserall:fsrs': mergeCardsFsrs,
  'fraser5:fsrs': mergeCardsFsrs,               // Fraser chapter 5 reading quiz: same record shape
  'chemunit:fsrs': mergeChemUnitFsrs,          // chemistry unit test: cards, plus missed, start, lastWorked
  'acct1:fsrs': mergeCardsFsrs,                // accounting 1, topic 1: the same card schedule
  'la10crucible:fsrs': mergeCardsFsrs,         // The Crucible, acts 1 and 2: same record shape
  'la10crucible34:fsrs': mergeCardsFsrs,       // The Crucible, acts 3 and 4: the same shape again
  'apushp12:fsrs': mergeCardsFsrs,             // APUSH period 1 and 2 test: same record shape
  'apush5saq:fsrs': mergeCardsFsrs,            // APUSH chapter 5 short answer quiz: same record shape
  'apush5saq:asknotes': mergeAskNotes,
  'apush5saq:trapnotes': mergeTrapNotes,
  'apush5saq:uimarks': mergeMarks,             // must knows and lessons, kept inside ui
  'apush5saq:askprefs': mergeSettings,
  'apushp12:asknotes': mergeAskNotes,          // notes kept beside Ask: union, deletes stick
  'fraser12:asknotes': mergeAskNotes,
  'fraser34:asknotes': mergeAskNotes,
  'fraserall:asknotes': mergeAskNotes,
  'fraser5:asknotes': mergeAskNotes,
  'acct1:asknotes': mergeAskNotes,
  'chemunit:asknotes': mergeAskNotes,
  'periodic:asknotes': mergeAskNotes,
  'alg2u1:asknotes': mergeAskNotes,
  'fifty-states:asknotes': mergeAskNotes,
  'la10crucible:asknotes': mergeAskNotes,
  'la10crucible34:asknotes': mergeAskNotes,
  'psychu0:asknotes': mergeAskNotes,
  'la10vocab1:asknotes': mergeAskNotes,
  'frchateaux:asknotes': mergeAskNotes,
  'la10crucible:trapnotes': mergeTrapNotes,    // trap notes (0025): one per card, a note beats a marker
  'la10crucible34:trapnotes': mergeTrapNotes,
  'psychu0:trapnotes': mergeTrapNotes,
  'la10vocab1:trapnotes': mergeTrapNotes,
  'frchateaux:trapnotes': mergeTrapNotes,
  'apushp12:trapnotes': mergeTrapNotes,
  'chemunit:trapnotes': mergeTrapNotes,       // chemistry concept cards (2026-09-18), asked for from the Ask panel
  /* Every kit material writes trap notes; these had no rule, so a note paid for on one device
   * could be dropped by the other device's later write. */
  'periodic:trapnotes': mergeTrapNotes,
  'fraser12:trapnotes': mergeTrapNotes,
  'fraser34:trapnotes': mergeTrapNotes,
  'fraserall:trapnotes': mergeTrapNotes,
  'fraser5:trapnotes': mergeTrapNotes,
  'acct1:trapnotes': mergeTrapNotes,
  'alg2u1:trapnotes': mergeTrapNotes,
  'fifty-states:trapnotes': mergeTrapNotes,
  'psychu0:fsrs': mergeCardsFsrs,              // Unit 0 research and statistics: same record shape
  'la10vocab1:fsrs': mergeCardsFsrs,           // vocabulary chapter 1: same record shape
  'frchateaux:fsrs': mergeCardsFsrs,           // les chateaux vocabulary: same record shape
  'la10crucible:uimarks': mergeMarks,          // progress kept inside the device-only ui key
  'la10crucible34:uimarks': mergeMarks,        // stretches walked, and the parts read in For you
  'apushp12:uimarks': mergeMarks,
  'la10vocab1:uimarks': mergeMarks,
  'fraser5:uimarks': mergeMarks,
  /* Ask panel preferences are a bag of independent switches, exactly like the periodic table's
   * settings: without a rule, a device that flips one switch pushes its stale copy of the others
   * back over. Every material writes this key. No per field stamps are written yet, so a field
   * both sides know falls back to the envelope time; a field only one side knows always survives,
   * which is what stops an older build stripping a newer one's switch. */
  'fifty-states:askprefs': mergeSettings,
  'periodic:askprefs': mergeSettings,
  'fraser12:askprefs': mergeSettings,
  'fraser34:askprefs': mergeSettings,
  'fraserall:askprefs': mergeSettings,
  'fraser5:askprefs': mergeSettings,
  'chemunit:askprefs': mergeSettings,
  'acct1:askprefs': mergeSettings,
  'alg2u1:askprefs': mergeSettings,
  'la10crucible:askprefs': mergeSettings,
  'la10crucible34:askprefs': mergeSettings,
  'apushp12:askprefs': mergeSettings,
  'psychu0:askprefs': mergeSettings,
  'la10vocab1:askprefs': mergeSettings,
  'frchateaux:askprefs': mergeSettings,
  /* The written quiz in the Fraser engine and its port to accounting: the submitted attempt and
   * the quiz in progress. The score also lands in exams, so a lost attempt kept the number and
   * lost the marked paper. */
  'fraser12:mcAttempt': makeSittingMerge('at'),
  'fraser34:mcAttempt': makeSittingMerge('at'),
  'fraserall:mcAttempt': makeSittingMerge('at'),
  'fraser5:mcAttempt': makeSittingMerge('at'),
  'acct1:mcAttempt': makeSittingMerge('at'),
  'fraser12:mcDraft': mergeQuizDraft,
  'fraser34:mcDraft': mergeQuizDraft,
  'fraserall:mcDraft': mergeQuizDraft,
  'fraser5:mcDraft': mergeQuizDraft,
  'acct1:mcDraft': mergeQuizDraft,
  /* Algebra 2 schedules nothing: its whole record is these keys (brought back for the unit test on
   * 2026-09-22), and not one of them had a rule. */
  'alg2u1:skills': mergeSkillCounts,
  'alg2u1:history': makeEventMerge(40, 'at'),
  'alg2u1:mockHistory': makeEventMerge(40, 'at'),
  'alg2u1:attempt': makeSittingMerge('at'),
  'alg2u1:mock': makeSittingMerge('at'),
  'alg2u1:lastDrill': mergeMax,
  /* Learn (2026-09-22): which lessons are finished, id -> when; a union keeps a lesson done on
   * one device done on the other. */
  'alg2u1:lessons': mergeMarks,
  /* 'alg2u1:draft' is deliberately left at newest write wins: it is { v } with nothing to date it
   * by and it is emptied on submit, so a union would resurrect answers that were just cleared. */
  'periodic:best': mergeMax,                   // sprint best: the higher score, from either device
  'periodic:setsDone': mergeRegionsDone,     // legacy ids; kept so an old device loses nothing
  'periodic:started': mergeNumberSet,        // set-size-independent successor to setsDone
  'periodic:settings': mergeSettings,
  'periodic:tests': makeEventMerge(40)
};

/* A best score is a maximum, not a document. Newest write wins would let a phone that
 * scored 14 overwrite the laptop's 22 just because it saved later. */
function mergeMax(aVal, bVal) {
  var a = typeof aVal === 'number' && isFinite(aVal) ? aVal : 0;
  var b = typeof bVal === 'number' && isFinite(bVal) ? bVal : 0;
  return Math.max(a, b);
}

function mtimeOf(entry) {
  return (entry && typeof entry.mtime === 'number') ? entry.mtime : 0;
}

function emptyEnvelope() {
  return { v: ENVELOPE_V, ns: {} };
}

/* Merges two envelopes into a new one. Pure: neither input is mutated. */
function mergeEnvelopes(a, b, registry) {
  var reg = registry || BUILTIN_MERGES;
  var aNs = (a && a.ns) || {};
  var bNs = (b && b.ns) || {};
  var merged = emptyEnvelope();
  var nsName;

  var names = {};
  for (nsName in aNs) if (Object.prototype.hasOwnProperty.call(aNs, nsName)) names[nsName] = true;
  for (nsName in bNs) if (Object.prototype.hasOwnProperty.call(bNs, nsName)) names[nsName] = true;

  for (nsName in names) {
    if (!Object.prototype.hasOwnProperty.call(names, nsName)) continue;
    var aKeys = aNs[nsName] || {};
    var bKeys = bNs[nsName] || {};
    var outKeys = {};
    var keyNames = {};
    var k;
    for (k in aKeys) if (Object.prototype.hasOwnProperty.call(aKeys, k)) keyNames[k] = true;
    for (k in bKeys) if (Object.prototype.hasOwnProperty.call(bKeys, k)) keyNames[k] = true;

    for (k in keyNames) {
      if (!Object.prototype.hasOwnProperty.call(keyNames, k)) continue;
      var aHas = Object.prototype.hasOwnProperty.call(aKeys, k);
      var bHas = Object.prototype.hasOwnProperty.call(bKeys, k);
      if (aHas && !bHas) { outKeys[k] = aKeys[k]; continue; }
      if (bHas && !aHas) { outKeys[k] = bKeys[k]; continue; }
      var aEntry = aKeys[k], bEntry = bKeys[k];
      var aM = mtimeOf(aEntry), bM = mtimeOf(bEntry);
      var fn = reg[nsName + ':' + k] || reg['*:' + k] || defaultMerge;
      outKeys[k] = {
        value: fn(aEntry ? aEntry.value : null, bEntry ? bEntry.value : null, aM, bM),
        mtime: Math.max(aM, bM)
      };
    }
    merged.ns[nsName] = outKeys;
  }
  return { merged: merged, changes: diffEnvelopes(a || emptyEnvelope(), merged) };
}

function isExcluded(ns, key) {
  if (SYNC_EXCLUDE_NS[ns]) return true;
  var list = SYNC_EXCLUDE[ns];
  return !!(list && list.indexOf(key) !== -1);
}

/* A copy of an envelope with every excluded key removed. Applied to whatever arrives from
 * the server or from a pasted backup, so a row written by an older build (which synced the
 * auth namespace) is cleaned on the next push rather than carried forever. Pure. */
function stripExcluded(env) {
  var out = emptyEnvelope();
  var src = (env && env.ns) || {};
  for (var ns in src) {
    if (!Object.prototype.hasOwnProperty.call(src, ns)) continue;
    var keys = src[ns] || {};
    for (var k in keys) {
      if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
      if (isExcluded(ns, k)) continue;
      if (!out.ns[ns]) out.ns[ns] = {};
      out.ns[ns][k] = keys[k];
    }
  }
  if (env && typeof env.v === 'number') out.v = env.v;
  return out;
}

/* entries: { "<ns>:<key>": value }, mtimes: { "<ns>:<key>": ms } */
function buildEnvelopeFrom(entries, mtimes, exclude) {
  var env = emptyEnvelope();
  for (var full in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, full)) continue;
    var split = full.indexOf(':');
    if (split <= 0) continue;
    var ns = full.slice(0, split);
    var key = full.slice(split + 1);
    if (!key) continue;
    if (exclude !== false && isExcluded(ns, key)) continue;
    if (!env.ns[ns]) env.ns[ns] = {};
    env.ns[ns][key] = {
      value: entries[full],
      mtime: (mtimes && typeof mtimes[full] === 'number') ? mtimes[full] : 0
    };
  }
  return env;
}

function diffEnvelopes(before, after) {
  var bNs = (before && before.ns) || {};
  var aNs = (after && after.ns) || {};
  var out = { totalChanged: 0, namespaces: {} };
  for (var ns in aNs) {
    if (!Object.prototype.hasOwnProperty.call(aNs, ns)) continue;
    var keys = {};
    for (var k in aNs[ns]) {
      if (!Object.prototype.hasOwnProperty.call(aNs[ns], k)) continue;
      var had = bNs[ns] && Object.prototype.hasOwnProperty.call(bNs[ns], k);
      var same = had && deepEqual(bNs[ns][k].value, aNs[ns][k].value);
      var verdict = !had ? 'added' : (same ? 'unchanged' : 'changed');
      keys[k] = verdict;
      if (verdict !== 'unchanged') out.totalChanged++;
    }
    out.namespaces[ns] = keys;
  }
  return out;
}

/* Human sentence for the import preview, e.g. "14 states updated, 2 exams added". */
function describeFsrsChange(beforeVal, afterVal) {
  var b = beforeVal && typeof beforeVal === 'object' ? beforeVal : {};
  var a = afterVal && typeof afterVal === 'object' ? afterVal : {};
  /* Each material names this map for whatever it drills: fifty-states uses 'states', the
   * periodic table uses 'cards'. Reading only 'states' made every periodic import report
   * "no changes" while silently moving hundreds of records: the user was being asked to
   * confirm an import on false information. */
  var bs = b.states || b.cards || {}, as = a.states || a.cards || {};
  var noun = (a.cards || b.cards) ? 'card' : 'state';
  var added = 0, updated = 0, name;
  for (name in as) {
    if (!Object.prototype.hasOwnProperty.call(as, name)) continue;
    if (!Object.prototype.hasOwnProperty.call(bs, name)) added++;
    else if (!deepEqual(bs[name], as[name])) updated++;
  }
  var bEx = Array.isArray(b.exams) ? b.exams.length : 0;
  var aEx = Array.isArray(a.exams) ? a.exams.length : 0;
  var parts = [];
  if (added) parts.push(added + ' ' + noun + (added === 1 ? '' : 's') + ' added');
  if (updated) parts.push(updated + ' ' + noun + (updated === 1 ? '' : 's') + ' updated');
  if (aEx > bEx) parts.push((aEx - bEx) + ' exam result' + ((aEx - bEx) === 1 ? '' : 's') + ' added');
  if (b.quizDate !== a.quizDate) parts.push('quiz date set to ' + (a.quizDate || 'none'));
  return parts.length ? parts.join(', ') : 'no changes';
}

/* ============================================================================
 * SECTION B: Node export, so tests/merge.test.mjs can load the real code.
 * ========================================================================== */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeCode: normalizeCode,
    formatCode: formatCode,
    defaultMerge: defaultMerge,
    mergeAskThreads: mergeAskThreads,
    mergeFsrsValue: mergeFsrsValue,
    mergeCardsFsrs: mergeCardsFsrs,
    makeFsrsMerge: makeFsrsMerge,
    mergeChemUnitFsrs: mergeChemUnitFsrs,
    mergeRegionsDone: mergeRegionsDone,
    mergeNumberSet: mergeNumberSet,
    mergeMax: mergeMax,
    mergeSettings: mergeSettings,
    mergeAskNotes: mergeAskNotes,
    mergeTrapNotes: mergeTrapNotes,
    mergeMarks: mergeMarks,
    makeSittingMerge: makeSittingMerge,
    mergeQuizDraft: mergeQuizDraft,
    mergeSkillCounts: mergeSkillCounts,
    SYNC_PARTIAL: SYNC_PARTIAL,
    mergeExams: mergeExams,
    makeEventMerge: makeEventMerge,
    pickStateRecord: pickStateRecord,
    mergeEnvelopes: mergeEnvelopes,
    buildEnvelopeFrom: buildEnvelopeFrom,
    stripExcluded: stripExcluded,
    isExcluded: isExcluded,
    diffEnvelopes: diffEnvelopes,
    describeFsrsChange: describeFsrsChange,
    emptyEnvelope: emptyEnvelope,
    deepEqual: deepEqual,
    canonicalJson: canonicalJson,
    SYNC_EXCLUDE: SYNC_EXCLUDE,
    SYNC_EXCLUDE_NS: SYNC_EXCLUDE_NS,
    BUILTIN_MERGES: BUILTIN_MERGES,
    CODE_ALPHABET: CODE_ALPHABET,
    CODE_LEN: CODE_LEN
  };
}

/* ============================================================================
 * SECTION C: browser wiring. Guarded so Node never reaches it.
 * ========================================================================== */

if (typeof window === 'undefined') return;

var MERGE_REGISTRY = {};
for (var bk in BUILTIN_MERGES) {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_MERGES, bk)) MERGE_REGISTRY[bk] = BUILTIN_MERGES[bk];
}

var defaultNamespace = null;
var listeners = { status: [], change: [] };
var state = { state: 'idle', message: '', lastSyncedAt: null };
var inFlight = false;
var pendingAgain = false;
var pushTimer = null;
var initialized = false;
var warnedCorrupt = false;
var FORCE_OFFLINE = false;

try {
  if (typeof location !== 'undefined' && /[?&]offline=1\b/.test(location.search)) FORCE_OFFLINE = true;
} catch (e) {}

/* -------------------------------------------------- localStorage plumbing */

function lsAvailable() {
  try {
    window.localStorage.setItem('studyhub:probe', '1');
    window.localStorage.removeItem('studyhub:probe');
    return true;
  } catch (e) { return false; }
}
var HAS_LS = lsAvailable();
var memFallback = {};   // last resort when localStorage is unavailable (private mode, quota)

function rawGet(k) {
  if (HAS_LS) { try { return window.localStorage.getItem(k); } catch (e) {} }
  return Object.prototype.hasOwnProperty.call(memFallback, k) ? memFallback[k] : null;
}
function rawSet(k, v) {
  memFallback[k] = v;
  if (HAS_LS) { try { window.localStorage.setItem(k, v); } catch (e) {} }
}
function rawRemove(k) {
  delete memFallback[k];
  if (HAS_LS) { try { window.localStorage.removeItem(k); } catch (e) {} }
}
function rawKeys() {
  var keys = [];
  if (HAS_LS) {
    try {
      for (var i = 0; i < window.localStorage.length; i++) keys.push(window.localStorage.key(i));
      return keys;
    } catch (e) {}
  }
  for (var k in memFallback) if (Object.prototype.hasOwnProperty.call(memFallback, k)) keys.push(k);
  return keys;
}

function readMeta() {
  var raw = rawGet(META_KEY);
  var meta = null;
  if (raw) { try { meta = JSON.parse(raw); } catch (e) { meta = null; } }
  if (!meta || typeof meta !== 'object') meta = {};
  if (meta.v !== 1) meta.v = 1;
  if (!meta.mtimes || typeof meta.mtimes !== 'object') meta.mtimes = {};
  if (typeof meta.pairCode === 'undefined') meta.pairCode = null;
  if (typeof meta.seenUpdatedAt === 'undefined') meta.seenUpdatedAt = null;
  if (typeof meta.lastSyncedAt === 'undefined') meta.lastSyncedAt = null;
  return meta;
}
function writeMeta(meta) { rawSet(META_KEY, JSON.stringify(meta)); }

/* dirtyEpoch counts local writes. A sync captures it when it reads the store, and only
 * clears the flag if nothing was written while the request was in the air. Otherwise a
 * review made mid-sync was marked clean, the closing flush saw nothing to send, and the
 * review waited on the device until the next visit. */
var dirtyEpoch = 0;
function isDirty() { return rawGet(DIRTY_KEY) === '1'; }
function markDirty() { dirtyEpoch++; rawSet(DIRTY_KEY, '1'); }
function clearDirty() { rawRemove(DIRTY_KEY); }

function storageKey(ns, key) { return STORE_PREFIX + ns + ':' + key; }

/* Walks localStorage and rebuilds the sync envelope from whatever is actually there.
 * Reading the store rather than tracking writes means data written by a material's
 * no-StudyStore fallback path is picked up too, since the key format is identical. */
function collectEntries() {
  var meta = readMeta();
  var entries = {};
  var keys = rawKeys();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!k || k.indexOf(STORE_PREFIX) !== 0) continue;
    if (k === META_KEY || k === DIRTY_KEY) continue;
    var full = k.slice(STORE_PREFIX.length);
    var split = full.indexOf(':');
    if (split <= 0) continue;
    /* Excluded namespaces are skipped before parsing: the auth token is a bare string, not
     * JSON, and parsing it only produced a warning about an "unreadable entry". */
    if (isExcluded(full.slice(0, split), full.slice(split + 1))) continue;
    var raw = rawGet(k);
    if (raw === null) continue;
    try {
      entries[full] = JSON.parse(raw);
    } catch (e) {
      if (!warnedCorrupt) {
        warnedCorrupt = true;
        console.warn('StudyStore: skipping unreadable entry ' + k);
      }
    }
  }
  /* The travelling part of each device-only 'ui' value, as the virtual key. */
  var mtimes = meta.mtimes;
  for (var pns in SYNC_PARTIAL) {
    if (!Object.prototype.hasOwnProperty.call(SYNC_PARTIAL, pns)) continue;
    var uiRaw = rawGet(storageKey(pns, 'ui'));
    if (uiRaw === null) continue;
    var ui = null;
    try { ui = JSON.parse(uiRaw); } catch (e2) { ui = null; }
    if (!ui || typeof ui !== 'object') continue;
    var part = {}, any = false, fields = SYNC_PARTIAL[pns];
    for (var fi = 0; fi < fields.length; fi++) {
      var fv = ui[fields[fi]];
      if (fv && typeof fv === 'object') { part[fields[fi]] = fv; any = true; }
    }
    if (!any) continue;
    var vk = pns + ':' + SYNC_PARTIAL_KEY;
    entries[vk] = part;
    if (mtimes === meta.mtimes) { mtimes = {}; for (var mk in meta.mtimes) if (Object.prototype.hasOwnProperty.call(meta.mtimes, mk)) mtimes[mk] = meta.mtimes[mk]; }
    /* Stamped by set() when the marks themselves move, so switching tabs does not look like
     * new progress. Marks older than this rule fall back to when 'ui' was last written. */
    mtimes[vk] = typeof meta.mtimes[vk] === 'number' ? meta.mtimes[vk]
      : (typeof meta.mtimes[pns + ':ui'] === 'number' ? meta.mtimes[pns + ':ui'] : 0);
  }
  return { entries: entries, mtimes: mtimes };
}

function partialOf(ns, ui) {
  var fields = SYNC_PARTIAL[ns] || [], part = {};
  if (ui && typeof ui === 'object') for (var i = 0; i < fields.length; i++) if (ui[fields[i]] && typeof ui[fields[i]] === 'object') part[fields[i]] = ui[fields[i]];
  return canonicalJson(part);
}

function buildEnvelope() {
  var c = collectEntries();
  return buildEnvelopeFrom(c.entries, c.mtimes, true);
}

/* Writes a merged envelope back to local storage, emitting a change event per key that
 * actually moved. Excluded keys are never in the envelope, so they are never touched. */
function applyEnvelope(env) {
  var meta = readMeta();
  var touched = [];
  var nsNames = (env && env.ns) || {};
  for (var ns in nsNames) {
    if (!Object.prototype.hasOwnProperty.call(nsNames, ns)) continue;
    for (var key in nsNames[ns]) {
      if (!Object.prototype.hasOwnProperty.call(nsNames[ns], key)) continue;
      if (isExcluded(ns, key)) continue;
      var entry = nsNames[ns][key];
      if (key === SYNC_PARTIAL_KEY && SYNC_PARTIAL[ns]) {
        /* Written back into the device's own 'ui', the listed fields only. */
        var uiKey = storageKey(ns, 'ui'), uiNow = null;
        try { uiNow = JSON.parse(rawGet(uiKey) || 'null'); } catch (e) { uiNow = null; }
        if (!uiNow || typeof uiNow !== 'object' || Array.isArray(uiNow)) uiNow = {};
        var pf = SYNC_PARTIAL[ns], pv = entry.value && typeof entry.value === 'object' ? entry.value : {}, moved = false;
        for (var pi = 0; pi < pf.length; pi++) {
          if (!pv[pf[pi]] || typeof pv[pf[pi]] !== 'object') continue;
          if (canonicalJson(uiNow[pf[pi]]) === canonicalJson(pv[pf[pi]])) continue;
          uiNow[pf[pi]] = pv[pf[pi]]; moved = true;
        }
        if (moved) { rawSet(uiKey, JSON.stringify(uiNow)); touched.push({ ns: ns, key: 'ui', value: uiNow }); }
        continue;
      }
      var sk = storageKey(ns, key);
      var next = JSON.stringify(entry.value);
      if (rawGet(sk) !== next) {
        rawSet(sk, next);
        touched.push({ ns: ns, key: key, value: entry.value });
      }
      meta.mtimes[ns + ':' + key] = mtimeOf(entry);
    }
  }
  writeMeta(meta);
  for (var i = 0; i < touched.length; i++) emit('change', touched[i]);
  return touched;
}

/* Entries written while sync.js was absent have no mtime. Stamping them "now" rather than
 * 0 is deliberate: 0 would make genuine offline work lose every merge against the server. */
function adoptOrphanMtimes() {
  var meta = readMeta();
  var now = Date.now();
  var changed = false;
  var keys = rawKeys();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!k || k.indexOf(STORE_PREFIX) !== 0) continue;
    if (k === META_KEY || k === DIRTY_KEY) continue;
    var full = k.slice(STORE_PREFIX.length);
    var split = full.indexOf(':');
    if (split <= 0) continue;
    if (isExcluded(full.slice(0, split), full.slice(split + 1))) continue;
    if (typeof meta.mtimes[full] !== 'number') { meta.mtimes[full] = now; changed = true; }
  }
  if (changed) writeMeta(meta);
}

/* -------------------------------------------------- events + status */

function emit(evt, payload) {
  var list = listeners[evt] || [];
  for (var i = 0; i < list.length; i++) {
    try { list[i](payload); } catch (e) {}
  }
}

/* What a sync is actually doing, so the panel can report real progress.
 *
 * A sync is not a stream. It is a short fixed sequence: read the row on the server, merge
 * it with what is on this device, send the result back. So the honest thing to publish is
 * which of those three steps is running, and there is no percentage of anything to measure
 * underneath it. The bar in the hub is drawn from the step number, and the label says
 * "step 2 of 3" in words so the number, not the width, is what the reader trusts.
 *
 * The review-log queue is the opposite case and genuinely countable: a known number of
 * events, sent 200 at a time, so "420 of 900" is a measurement. */
var SYNC_STEPS = ['pull', 'merge', 'push'];
var SYNC_STEP_LABELS = {
  pull:  'Reading the server copy',
  merge: 'Merging with this device',
  push:  'Sending your changes'
};
var progress = null;            // sync steps, or null when no sync is running
var telemetryProgress = null;   // { sent, total } while the review queue is draining

function setProgress(step, attempt) {
  var i = SYNC_STEPS.indexOf(step);
  progress = (i === -1) ? null : {
    step: step,
    index: i + 1,
    of: SYNC_STEPS.length,
    label: SYNC_STEP_LABELS[step] || '',
    attempt: attempt || 1,
    attempts: MAX_SYNC_ATTEMPTS
  };
  emit('status', statusSnapshot());
}

function statusSnapshot() {
  var meta = readMeta();
  return {
    state: state.state,
    message: state.message,
    paired: !!meta.pairCode,
    codeDisplay: meta.pairCode ? formatCode(meta.pairCode) : null,
    configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
    lastSyncedAt: meta.lastSyncedAt,
    dirty: isDirty(),
    progress: progress,
    telemetry: telemetryProgress
  };
}

function setState(next, message) {
  state.state = next;
  state.message = message || '';
  /* Leaving the syncing state ends the sequence, whichever way it ended, so the steps go
   * with it. Forgetting this would strand a half-drawn bar on screen after a failure. */
  if (next !== 'syncing') progress = null;
  emit('status', statusSnapshot());
}

/* -------------------------------------------------- Supabase RPC */

function rpc(name, body, useKeepalive) {
  var opts = {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
  if (useKeepalive) opts.keepalive = true;
  return fetch(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + name, opts)
    .then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var err = new Error('sync ' + name + ' failed (' + res.status + ')');
          err.status = res.status;
          err.detail = t;
          throw err;
        });
      }
      return res.json();
    });
}

function rpcPull(code) { return rpc('sync_pull', { p_code: code }); }
function rpcPush(code, payload, seen, useKeepalive) {
  return rpc('sync_push', {
    p_code: code,
    p_payload: payload,
    p_seen_updated_at: seen
  }, useKeepalive);
}

/* -------------------------------------------------- the sync cycle */

function canSync() {
  var meta = readMeta();
  return !!(meta.pairCode && SUPABASE_URL && SUPABASE_ANON_KEY);
}

/* navigator.onLine is a hint, never evidence. On ChromeOS in particular it reports false
 * while the network is perfectly fine, and treating that as proof strands sync forever:
 * the 'online' event only fires on a transition, so a device that was never "offline" in
 * the browser's eyes never gets told to try again. The only trustworthy signal that we
 * cannot reach the server is a request that actually failed, so that is what we use. */
function isOffline() {
  return FORCE_OFFLINE;
}
function looksOffline() {
  try { return navigator.onLine === false; } catch (e) { return false; }
}

/* Keep trying by ourselves. Without this, a device that guessed wrong about the network
 * would sit there holding unsent work until someone happened to switch tabs. */
var retryTimer = null, retryDelay = 15000;
var RETRY_MIN = 15000, RETRY_MAX = 300000;
function scheduleRetry() {
  if (retryTimer || !canSync()) return;
  retryTimer = setTimeout(function () {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
    syncNow('retry');
  }, retryDelay);
}
function clearRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = RETRY_MIN;
}

function syncNow(reason) {
  if (!canSync()) { setState('idle', ''); return Promise.resolve(false); }
  if (isOffline()) {
    setState('offline', 'Offline: changes saved on this device.');
    return Promise.resolve(false);
  }
  if (inFlight) { pendingAgain = true; return Promise.resolve(false); }

  inFlight = true;
  setState('syncing', 'Syncing…');
  var meta = readMeta();
  var code = meta.pairCode;

  function attempt(n, known) {
    // known = server row we already hold ({payload, updated_at}) or null to pull fresh.
    setProgress('pull', n + 1);
    var step = known ? Promise.resolve(known) : rpcPull(code).then(function (r) {
      return (r && r.found) ? { payload: r.payload, updated_at: r.updated_at } : null;
    });

    return step.then(function (remote) {
      setProgress('merge', n + 1);
      var epoch = dirtyEpoch;
      var local = buildEnvelope();
      /* The server row is cleaned of anything that should never have been in it, so the
       * push that follows drops it from the row rather than carrying it forever. */
      var remoteEnv = remote ? stripExcluded(remote.payload) : null;
      var merged = remote ? mergeEnvelopes(local, remoteEnv, MERGE_REGISTRY).merged : local;
      applyEnvelope(merged);

      function settled(updatedAt) {
        var m = readMeta();
        m.seenUpdatedAt = updatedAt;
        writeMeta(m);
        if (dirtyEpoch === epoch) clearDirty();
        else schedulePush();          // something landed mid-flight; send it soon
        return true;
      }

      if (remote && deepEqual(merged, remote.payload)) return settled(remote.updated_at);

      setProgress('push', n + 1);
      return rpcPush(code, merged, remote ? remote.updated_at : null).then(function (res) {
        if (res && res.ok) return settled(res.updated_at);
        // Someone pushed between our pull and our push. The server handed back the
        // current row, so re-merge against it instead of pulling again.
        if (n + 1 >= MAX_SYNC_ATTEMPTS) return false;
        return attempt(n + 1, { payload: res.payload, updated_at: res.updated_at });
      });
    });
  }

  return attempt(0, null).then(function (ok) {
    if (ok) {
      var m = readMeta();
      m.lastSyncedAt = Date.now();
      writeMeta(m);
      clearRetry();
      setState('idle', '');
    } else {
      setState('error', 'Could not settle with the server. Will retry.');
      scheduleRetry();
    }
    return ok;
  }).catch(function (err) {
    // A rejected fetch has no status: that is a real network failure. An HTTP status
    // means we reached the server and it objected, which is a different problem.
    if (!err || !err.status) {
      setState('offline', 'No connection: changes are saved here and will send themselves.');
    } else {
      var detail = String(err.detail || '');
      setState('error', err.status === 404
        ? 'Sync functions missing on the server: run the migration.'
        : /payload_rejected/.test(detail)
          ? 'Too much data to sync in one go. Everything is still saved on this device.'
          : /rate_limited/.test(detail)
            ? 'Too many attempts from this network. Will retry in a while.'
            : 'Sync error. Will retry.');
    }
    scheduleRetry();
    return false;
  }).then(function (ok) {
    inFlight = false;
    if (pendingAgain) {
      pendingAgain = false;
      setTimeout(function () { syncNow('requeue'); }, 1000);
    }
    return ok;
  });
}

/* Best-effort push as the page goes away. keepalive, not sendBeacon, because we must set
 * the apikey header. Never load-bearing: the dirty flag survives and the next load pushes. */
/* It used to return without sending anything when the envelope was over the keepalive cap,
 * and with several materials of card records that is the usual size. The last stretch of a
 * session then waited on the device until it was next opened, which is exactly the "I did it
 * on my phone and it is not on my laptop" report. When the body is too big for keepalive, a
 * normal sync is started instead: on a tab switch or an app going to the background it has
 * time to finish, and on a real unload it is no worse than sending nothing. */
function finalFlush() {
  if (!canSync() || !isDirty() || isOffline()) return;
  var meta = readMeta();
  var env = buildEnvelope();
  var body = JSON.stringify(env);
  if (body.length > KEEPALIVE_LIMIT) { syncNow('hidden'); return; }
  try { rpcPush(meta.pairCode, env, meta.seenUpdatedAt, true).catch(function () {}); } catch (e) {}
}

/* What this device would send, per namespace: which keys travel, which stay here, and how
 * big it all is. The hub prints it so "does this save" has an answer on the page. */
function syncSummary() {
  var c = collectEntries();
  var env = buildEnvelopeFrom(c.entries, c.mtimes, true);
  var out = { bytes: JSON.stringify(env).length, limit: 1048576, namespaces: {} };
  var keys = rawKeys();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!k || k.indexOf(STORE_PREFIX) !== 0 || k === META_KEY || k === DIRTY_KEY) continue;
    var full = k.slice(STORE_PREFIX.length), split = full.indexOf(':');
    if (split <= 0) continue;
    var ns = full.slice(0, split), key = full.slice(split + 1);
    if (SYNC_EXCLUDE_NS[ns]) continue;
    var row = out.namespaces[ns] || (out.namespaces[ns] = { synced: [], local: [], bytes: 0 });
    if (isExcluded(ns, key)) row.local.push(key);
    else { row.synced.push(key); row.bytes += (rawGet(k) || '').length; }
  }
  return out;
}

function schedulePush() {
  if (pushTimer) return;   // throttle, not debounce: a debounce would never fire while studying
  pushTimer = setTimeout(function () {
    pushTimer = null;
    syncNow('throttle');
  }, PUSH_THROTTLE_MS);
}

/* -------------------------------------------------- export / import */

function bytesToBase64(bytes) {
  var chunk = 0x8000, out = '';
  for (var i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}
function base64ToBytes(b64) {
  var bin = atob(b64.replace(/[\s]/g, ''));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function exportCode() {
  var json = JSON.stringify(buildEnvelope());
  var bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'undefined') {
    return Promise.resolve('SH0:' + bytesToBase64(bytes));
  }
  var cs = new CompressionStream('deflate-raw');
  var stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Response(stream).arrayBuffer().then(function (buf) {
    return 'SH1:' + bytesToBase64(new Uint8Array(buf));
  }).catch(function () {
    return 'SH0:' + bytesToBase64(bytes);
  });
}

function decodeExport(str) {
  var s = String(str || '').trim().replace(/\s+/g, '');
  if (!s) return Promise.reject(new Error('Paste a backup code first.'));
  if (s.indexOf('SH0:') === 0) {
    return Promise.resolve(new TextDecoder().decode(base64ToBytes(s.slice(4))));
  }
  if (s.indexOf('SH1:') === 0) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('This browser cannot read compressed backups. Export again from the other device. It will fall back to the uncompressed format.'));
    }
    var bytes = base64ToBytes(s.slice(4));
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new TextDecoder().decode(new Uint8Array(buf));
    });
  }
  return Promise.reject(new Error('That does not look like a Study Hub backup (it should start with SH1: or SH0:).'));
}

/* Two-phase by design: nothing is written until the caller runs commit(), so the hub can
 * show what would change and let the user back out. */
function previewImport(str) {
  return decodeExport(str).then(function (json) {
    var env;
    try { env = JSON.parse(json); }
    catch (e) { throw new Error('The backup code is damaged (bad JSON).'); }
    if (!env || env.v !== ENVELOPE_V || !env.ns || typeof env.ns !== 'object') {
      throw new Error('Unrecognised backup format (expected version ' + ENVELOPE_V + ').');
    }
    env = stripExcluded(env);   // a backup made by an older build may carry credentials
    var local = buildEnvelope();
    var merged = mergeEnvelopes(local, env, MERGE_REGISTRY).merged;
    var diff = diffEnvelopes(local, merged);
    var lines = [];
    for (var ns in diff.namespaces) {
      if (!Object.prototype.hasOwnProperty.call(diff.namespaces, ns)) continue;
      for (var key in diff.namespaces[ns]) {
        if (!Object.prototype.hasOwnProperty.call(diff.namespaces[ns], key)) continue;
        if (diff.namespaces[ns][key] === 'unchanged') continue;
        var detail = '';
        if (key === 'fsrs') {
          var beforeVal = (local.ns[ns] && local.ns[ns][key]) ? local.ns[ns][key].value : null;
          detail = ' (' + describeFsrsChange(beforeVal, merged.ns[ns][key].value) + ')';
        } else if (key === 'regionsDone' || key === 'setsDone' || key === 'started') {
          var bn = (local.ns[ns] && local.ns[ns][key] && Array.isArray(local.ns[ns][key].value))
            ? local.ns[ns][key].value.length : 0;
          var an = merged.ns[ns][key].value.length;
          var unit = key === 'started' ? 'elements' : key === 'setsDone' ? 'sets' : 'regions';
          detail = ' (' + an + ' ' + unit + ' total, ' + Math.max(0, an - bn) + ' new)';
        }
        lines.push(ns + ' / ' + key + ': ' + diff.namespaces[ns][key] + detail);
      }
    }
    return {
      ok: true,
      totalChanged: diff.totalChanged,
      summary: lines.length ? lines : ['Nothing new: this device is already up to date.'],
      commit: function () {
        applyEnvelope(merged);
        markDirty();
        syncNow('import');
        return diff;
      },
      discard: function () {}
    };
  });
}

/* -------------------------------------------------- service worker */

var lastUpdateCheck = 0;
var UPDATE_MIN_GAP = 90 * 1000;          // floor between checks, whatever asks for one
var UPDATE_POLL_MS = 3 * 60 * 1000;      // and a heartbeat, for a tab nobody touches
var swReloading = false;

/* Look for a newer build. Called on load, whenever the tab comes back to the front, and
   the moment the device regains a connection, which is the case that matters on a phone
   that was opened on mobile data or out of range. */
function checkForUpdate(reg, force) {
  if (!reg) return;
  var now = Date.now();
  if (!force && now - lastUpdateCheck < UPDATE_MIN_GAP) return;
  lastUpdateCheck = now;
  try { reg.update().catch(function () {}); } catch (e) {}
}

/* Swap to a waiting build on its own, but never while someone is typing into a material:
   a reload mid-answer would be its own kind of bug. If they are, it waits for the next
   quiet moment, and the hub's "Update now" button is always there as the manual path. */
function adoptWhenIdle(worker) {
  if (!worker || swReloading) return;
  var tryNow = function () {
    var el = document.activeElement;
    var typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (typing || document.visibilityState !== 'visible') return false;
    swReloading = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
    return true;
  };
  if (tryNow()) return;
  var iv = setInterval(function () { if (tryNow()) clearInterval(iv); }, 4000);
  setTimeout(function () { clearInterval(iv); }, 120000);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !SCRIPT_URL) return;
  var swUrl;
  try {
    var u = new URL(SCRIPT_URL);
    if (u.origin !== location.origin) return;
    swUrl = new URL('../sw.js', SCRIPT_URL).href;   // assets/../sw.js == hub root
  } catch (e) { return; }

  try {
    /* updateViaCache 'none' matters here: GitHub Pages serves sw.js with a max-age, and
     * without this the browser would answer an update check from its HTTP cache and the
     * poll above would be looking at a stale copy of the worker for ten minutes at a time. */
    /* Whether a worker was already in charge when this page loaded. On the very first
     * visit there is none: the new worker claims the page as it activates, which fires
     * controllerchange, and treating that as "a new build arrived" reloaded every first
     * visit for nothing, mid-material included. */
    var hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' }).then(function (reg) {
      /* register() has just fetched sw.js and compared it, so a second check here would
       * only repeat that request. Start the clock instead. */
      lastUpdateCheck = Date.now();

      if (reg.waiting && navigator.serviceWorker.controller) adoptWhenIdle(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) adoptWhenIdle(nw);
        });
      });

      window.addEventListener('online', function () { checkForUpdate(reg, true); });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') checkForUpdate(reg, false);
      });

      /* A tab left open all afternoon would otherwise never look again: the load check has
       * already run, and neither visibility nor connectivity changes while you sit there
       * studying. Only poll while the tab is actually in front and online, so a backgrounded
       * phone is not spending battery or data on it. */
      setInterval(function () {
        if (document.visibilityState !== 'visible') return;
        if (isOffline()) return;
        checkForUpdate(reg, false);
      }, UPDATE_POLL_MS);
    }).catch(function () {});

    /* A new build has taken over. Every open tab hears this, including a material sitting
     * in a background tab: that one waits until it is looked at again, so the reload
     * never lands on a page nobody can see. */
    var reloaded = false;
    var reloadNow = function () {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController && !swReloading) { hadController = true; return; }   // first install
      if (document.visibilityState === 'visible') return reloadNow();
      document.addEventListener('visibilitychange', function onVis() {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onVis);
        reloadNow();
      });
    });
  } catch (e) {}
}

/* -------------------------------------------------- telemetry */
/* Anonymous review logs, kept so the scheduler can be checked against reality and its
 * weights refitted later. An FSRS optimiser needs one thing above all: what the model
 * predicted your chance of recall was, set against whether you actually recalled it. That
 * pair is what an event carries.
 *
 * What goes out per review: which material, a card key (an element symbol and a direction,
 * or a state name), the grade, how long the answer took, and the model's own numbers at
 * the moment it asked. What does not go out: any name, any code, any address, anything you
 * typed. The card key is the question, never your answer to it.
 *
 * Local-first like everything else here. Events queue on the device and are only ever sent
 * over a live connection; with no connection they simply wait. The queue is capped, and
 * when it is full the OLDEST events are dropped rather than the newest, because a queue
 * that has overflowed is one that has not reached the server in a long time and the recent
 * reviews are the ones still worth having. */
var TELEMETRY_MAX   = 1000;   // events held on the device before the oldest are dropped
var TELEMETRY_BATCH = 200;    // events per request
var TELEMETRY_FLUSH_MS = 5 * 60 * 1000;
/* The queue itself lives in storage and is read back every time it is needed. Holding a
 * copy in memory looked cheaper, but the hub and a material can be open in two tabs at
 * once, and two copies of one queue meant whichever tab wrote last erased the other's
 * reviews. What this tab has recorded and not yet written is all that is kept here. */
var telemetryPending = [];
var telemetryWriteT = 0;
var telemetryBusy = false;
/* Set when the server has no telemetry_ingest function, which is the state of a project
 * whose 0004 migration has not been run yet. Sending would 404 on every review, so it is
 * tried once per page load and then left alone. */
var telemetryUnavailable = false;

var TEL_PREF_KEY  = STORE_PREFIX + 'hub:telemetry';
var TEL_QUEUE_KEY = STORE_PREFIX + 'hub:telemetryQueue';
var TEL_ID_KEY    = STORE_PREFIX + 'hub:installId';

/* Default on, and said so plainly in the interface rather than buried here. */
function telemetryEnabled() {
  var raw = rawGet(TEL_PREF_KEY);
  if (raw === null || raw === '') return true;
  try { return JSON.parse(raw) !== false; } catch (e) { return true; }
}
function telemetrySetEnabled(on) {
  on = !!on;
  rawSet(TEL_PREF_KEY, JSON.stringify(on));
  /* Stamped and pushed the same way StudyStore.set does it, so the choice reaches the
     other devices instead of sitting here as an untracked write. */
  try {
    var meta = readMeta();
    meta.mtimes['hub:telemetry'] = Date.now();
    writeMeta(meta);
    markDirty();
    schedulePush();
  } catch (e) {}
  /* Turning it off discards what has not been sent. Keeping a queue you have just opted
   * out of, in the hope you opt back in, is not a decision this should make for you. */
  if (!on) { telemetryPending = []; clearTimeout(telemetryWriteT); rawRemove(TEL_QUEUE_KEY); }
  return on;
}

/* A random per-device id, so one device's reviews can be told apart from another's without
 * anyone having to be identified. It is not tied to a person, a code or a session.
 *
 * It used to live in localStorage alone, so anything that cleared localStorage made the same
 * browser look like a new visitor. Since 2026-09-22 it is also kept in a first party cookie
 * and in IndexedDB, and read back from whichever survived. How it was found, when it was
 * minted and whether the browser showed signs of an earlier visit at that moment go out with
 * the device description (see deviceProfile), so a wiped browser reads as the same browser
 * wiped, not as a new person. Clearing all site data still throws every copy away. */
var TEL_ID_META_KEY = STORE_PREFIX + 'hub:installMeta';
var ID_COOKIE = 'studyhub_id';
var ID_RE = /^[0-9a-fx][0-9a-z]{15,63}$/;

function randomHex(n) {
  try {
    var bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  } catch (e) {
    var s = 'x';
    while (s.length < n * 2) s += Math.random().toString(36).slice(2);
    return s.slice(0, n * 2);
  }
}

/* What the browser looked like before this page wrote anything: taken while this script is
 * parsed, which is before the material's own script runs. A service worker already in charge
 * of the page, or hub data already in localStorage, means this browser has been here before. */
var BOOT_PRIOR = (function () {
  var out = [];
  try { if (navigator.serviceWorker && navigator.serviceWorker.controller) out.push('sw'); } catch (e) {}
  try {
    var ks = rawKeys(), n = 0;
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i] || '';
      if (k.indexOf(STORE_PREFIX) === 0 && k !== TEL_ID_KEY && k !== TEL_ID_META_KEY &&
          k.indexOf(STORE_PREFIX + 'auth:') !== 0 && k !== 'studyhub:probe') n++;
    }
    if (n) out.push('store');
  } catch (e) {}
  return out;
})();
/* The offline cache answers asynchronously, so it is checked now and read when needed. */
try {
  if (typeof caches !== 'undefined' && caches.keys) {
    caches.keys().then(function (names) { if (names && names.length) BOOT_PRIOR.push('cache'); }, function () {});
  }
} catch (e) {}

function readIdCookie() {
  try {
    var m = document.cookie.match(new RegExp('(?:^|; )' + ID_COOKIE + '=([^;]+)'));
    var v = m ? decodeURIComponent(m[1]) : null;
    return v && ID_RE.test(v) ? v : null;
  } catch (e) { return null; }
}
function writeIdCookie(id) {
  try {
    document.cookie = ID_COOKIE + '=' + encodeURIComponent(id) +
      '; max-age=' + (400 * 24 * 3600) + '; path=/; samesite=lax' +
      (location.protocol === 'https:' ? '; secure' : '');
  } catch (e) {}
}
function idbOpen() {
  return new Promise(function (resolve, reject) {
    try {
      var req = indexedDB.open('studyhub-id', 1);
      req.onupgradeneeded = function () { try { req.result.createObjectStore('kv'); } catch (e) {} };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    } catch (e) { reject(e); }
  });
}
function idbGetId() {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve) {
      try {
        var r = db.transaction('kv', 'readonly').objectStore('kv').get('install');
        r.onsuccess = function () { var v = r.result; resolve(typeof v === 'string' && ID_RE.test(v) ? v : null); };
        r.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }).catch(function () { return null; });
}
function idbPutId(id) {
  idbOpen().then(function (db) {
    try { db.transaction('kv', 'readwrite').objectStore('kv').put(id, 'install'); } catch (e) {}
  }).catch(function () {});
}

function readIdMeta() {
  try { var m = JSON.parse(rawGet(TEL_ID_META_KEY) || 'null'); return m && typeof m === 'object' ? m : null; }
  catch (e) { return null; }
}

var idMirrored = false;
function adoptId(id, how) {
  rawSet(TEL_ID_KEY, id);
  var meta = readIdMeta();
  if (!meta || how === 'new') {
    meta = { born: Date.now(), how: how, prior: how === 'new' ? BOOT_PRIOR.slice() : [] };
  } else {
    meta.how = how;   // recovered: keep when it was born, note how it came back
  }
  rawSet(TEL_ID_META_KEY, JSON.stringify(meta));
}

function installId() {
  var id = rawGet(TEL_ID_KEY);
  if (!id) {
    var fromCookie = readIdCookie();
    if (fromCookie) { id = fromCookie; adoptId(id, 'cookie'); }
    else { id = randomHex(16); adoptId(id, 'new'); }
  }
  if (!idMirrored) { idMirrored = true; writeIdCookie(id); idbPutId(id); }
  return id;
}

/* IndexedDB can only be read asynchronously, so a browser whose localStorage and cookie are
 * both gone gets one chance to find the id there before anything is sent. Every send waits
 * for this; it settles in milliseconds and never throws. */
var idReady = (function () {
  try {
    if (rawGet(TEL_ID_KEY) || readIdCookie() || typeof indexedDB === 'undefined') return Promise.resolve();
    return idbGetId().then(function (id) { if (id && !rawGet(TEL_ID_KEY)) adoptId(id, 'idb'); });
  } catch (e) { return Promise.resolve(); }
})();

function telemetryRead() {
  var raw = rawGet(TEL_QUEUE_KEY), q = [];
  try { q = raw ? JSON.parse(raw) : []; } catch (e) { q = []; }
  return Array.isArray(q) ? q : [];
}
function telemetryWrite(q) {
  try { rawSet(TEL_QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
}
/* One review is identified by what was asked and when. The server dedupes on the same
 * three fields, so a batch sent twice (a dropped response, two tabs flushing at once) is
 * counted once there too. */
function telemetryKey(e) { return String(e.m) + '|' + String(e.c) + '|' + String(e.t); }

/* Appends this tab's unwritten reviews to whatever is in storage now, rather than replacing
 * it, so a second tab's reviews are never overwritten. */
function telemetryPersistNow() {
  clearTimeout(telemetryWriteT);
  if (!telemetryPending.length) return;
  var q = telemetryRead().concat(telemetryPending);
  telemetryPending = [];
  if (q.length > TELEMETRY_MAX) q.splice(0, q.length - TELEMETRY_MAX);
  telemetryWrite(q);
}
/* Debounced: a speed round writes an event every couple of seconds and there is no reason
 * for each one to serialise the whole queue. */
function telemetryPersist() {
  clearTimeout(telemetryWriteT);
  telemetryWriteT = setTimeout(telemetryPersistNow, 2000);
}

/* Answer time, corrected for the page being in the background (2026-09-22). The materials
 * time an answer from when the question appeared, and none of them pauses that clock while
 * the phone is locked or another app is in front, so a question left on screen overnight read
 * as an eight hour answer (and then as none, past the 30 minute cap). This page knows when it
 * was hidden, so that time is taken off here, for every material at once. Where a mode sends
 * no time at all (a speed round, a match, a practice card), the gap since this page's previous
 * answer stands in, minus the same hidden time. Quizzes and tests marked in one go are left
 * alone: their answers arrive together and a gap would say nothing. 'mt' says which it was:
 * 'page' as measured, 'net' measured less time away, 'gap' estimated, 'hidden' answered while
 * the page could not be seen (so not by a person). */
var hiddenSpans = [];
var hiddenSince = 0;
var lastAnswerT = 0;
try { if (document.visibilityState === 'hidden') hiddenSince = Date.now(); } catch (e) {}
try {
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { if (!hiddenSince) hiddenSince = Date.now(); }
    else if (hiddenSince) {
      hiddenSpans.push([hiddenSince, Date.now()]);
      if (hiddenSpans.length > 200) hiddenSpans.shift();
      hiddenSince = 0;
    }
  });
} catch (e) {}
function hiddenWithin(a, b) {
  var t = 0, spans = hiddenSpans.concat(hiddenSince ? [[hiddenSince, Date.now()]] : []);
  for (var i = 0; i < spans.length; i++) {
    var lo = Math.max(a, spans[i][0]), hi = Math.min(b, spans[i][1]);
    if (hi > lo) t += hi - lo;
  }
  return t;
}
function adjustTiming(ev) {
  try {
    var t = +ev.t || Date.now();
    /* Nobody taps a page they cannot see: an answer that arrives while the page is hidden came
       from a script (a test run, an automation), and is labelled so rather than corrected. */
    if (document.visibilityState === 'hidden') { ev.mt = 'hidden'; if (t > lastAnswerT) lastAnswerT = t; return; }
    if (typeof ev.ms === 'number' && ev.ms > 0) {
      var away = hiddenWithin(t - ev.ms, t);
      if (away > 0) { ev.ms = Math.max(1, Math.round(ev.ms - away)); ev.mt = 'net'; }
      else ev.mt = 'page';
    } else if (lastAnswerT && !/^(quiz|test)/.test(String(ev.k || '')) &&
               t - lastAnswerT >= 300 && t - lastAnswerT < 18e5) {
      ev.ms = Math.max(1, Math.round(t - lastAnswerT - hiddenWithin(lastAnswerT, t)));
      ev.mt = 'gap';
    }
    if (t > lastAnswerT) lastAnswerT = t;
  } catch (e) {}
}

function telemetryRecord(ev) {
  if (!telemetryEnabled() || !ev || typeof ev !== 'object') return;
  adjustTiming(ev);
  telemetryPending.push(ev);
  telemetryPersist();
  visitOnReview(ev);
}

function telemetryPendingCount() {
  return telemetryRead().length + telemetryPending.length;
}

/* Sends the whole queue, a batch at a time, and reports how far through it is.
 *
 * It used to send one batch and stop until something asked again, which is five minutes
 * away at worst. A device that built up a backlog while the server had no ingest function
 * would then have drained 200 events per five minutes: a full queue of a thousand needed
 * the best part of an hour with the tab open. Now it keeps going while it is working. */
/* A page served from a local test server records like any other but sends nothing, unless the
 * tester opts in with localStorage 'studyhub:hub:telemetryLocal' = '1'. Until 2026-09-22 local
 * test runs sent their scripted answers to the live log, where one showed up as a "student"
 * answering every card in a tenth of a second. */
function isLocalTest() {
  try {
    if (!(/^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(location.hostname) || location.protocol === 'file:')) return false;
    return rawGet(STORE_PREFIX + 'hub:telemetryLocal') !== '1';
  } catch (e) { return false; }
}

function telemetryFlush(useKeepalive) {
  /* Written to storage before anything can bail out: a page going away while a send is in
     flight, or on a local test server, used to lose the answers of its last two seconds. */
  telemetryPersistNow();
  if (telemetryBusy || telemetryUnavailable || !telemetryEnabled() || isLocalTest()) return Promise.resolve(0);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return Promise.resolve(0);
  if (isOffline()) return Promise.resolve(0);
  telemetryPersistNow();
  var total = telemetryRead().length;
  if (!total) return Promise.resolve(0);

  telemetryBusy = true;
  telemetryProgress = { sent: 0, total: total };
  emit('status', statusSnapshot());

  var MAX_ROUNDS = Math.ceil(TELEMETRY_MAX / TELEMETRY_BATCH) + 2;   // belt and braces

  function round(sent, n) {
    var q = telemetryRead();
    if (!q.length || n >= MAX_ROUNDS) return Promise.resolve(sent);
    var batch = q.slice(0, TELEMETRY_BATCH);
    return rpc('telemetry_ingest', { p_install: installId(), p_events: batch }, !!useKeepalive)
      .then(function () {
        /* Remove exactly what was sent from whatever storage holds now. Reviews recorded
         * while the request was in flight, here or in another tab, stay in the queue. */
        var done = {};
        for (var i = 0; i < batch.length; i++) done[telemetryKey(batch[i])] = true;
        telemetryWrite(telemetryRead().filter(function (e) { return !done[telemetryKey(e)]; }));
        sent += batch.length;
        telemetryProgress = { sent: sent, total: Math.max(total, sent) };
        emit('status', statusSnapshot());
        /* A page that is going away gets one request and no more: keepalive buys a single
         * send past the unload, not a conversation. The rest waits for the next visit. */
        if (useKeepalive) return sent;
        return round(sent, n + 1);
      });
  }

  function finish(n) {
    telemetryBusy = false;
    telemetryProgress = null;
    emit('status', statusSnapshot());
    return n;
  }

  return idReady.then(function () { return round(0, 0); }).then(finish).catch(function (err) {
    if (err && (err.status === 404 || err.status === 400)) telemetryUnavailable = true;
    finish(0);
    return 0;   // whatever is left is left alone, so nothing is lost by a failed send
  });
}

function telemetryStart() {
  try {
    window.addEventListener('online', function () { telemetryFlush(); });
    /* Hidden is the moment that matters on a phone: an app swiped away from the switcher
     * often never fires pagehide at all, so the send has to go out here, with keepalive so
     * it outlives the page. pagehide is kept as the second chance. */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') telemetryFlush();
      else telemetryFlush(true);
    });
    window.addEventListener('pagehide', function () { telemetryFlush(true); });
    setInterval(function () { telemetryFlush(); }, TELEMETRY_FLUSH_MS);
  } catch (e) {}
  setTimeout(function () { telemetryFlush(); }, 8000);
}

/* -------------------------------------------------- visits */
/* What happens around the answers (2026-09-22). The review log says what was answered; it
 * cannot say whether a student who stopped after fourteen answers had finished, gave up, or
 * hit a broken page, and it cannot tell one browser wiped from two people. So each page load
 * also keeps a short diary, under the same switch as the review log:
 *
 *   open     the page loaded: where the link came from (a host name only, never a path) and
 *            whether it was a reload
 *   hide     the page went to the background: time actually in front of the student so far,
 *            answers so far, the screen it was on. On a phone this is usually the last thing a
 *            page ever says, so it carries everything a close would.
 *   show     it came back
 *   close    the page is going away, with the same figures
 *   screen   the material switched tab (read from the tab name the material already saves)
 *   error    a script error or a rejected promise: the message, the file name and line
 *   nudge    the rough start suggestion was shown, and what was chosen
 *   checkin  the after the quiz question, and the answer
 *
 * Plus, with every send, a coarse description of the browser (deviceProfile). Nothing here
 * names anybody or carries anything typed, except the optional quiz score, which the student
 * types into a box that says what it is for. */
var VISIT_Q_KEY   = STORE_PREFIX + 'hub:visitQueue';
var SEEN_KEY      = STORE_PREFIX + 'hub:seen';
var PERSON_KEY_NS = 'hub', PERSON_KEY = 'person';
var VISIT_MAX = 300;
var PAGE_ID = randomHex(8);
var PAGE_T0 = Date.now();
var visitPending = [];
var visitWriteT = 0;
var visitBusy = false;
var visitUnavailable = false;
var visit = {
  material: null,        // 'apush/fraser-ch5' once known
  answers: 0, right: 0,
  lastStep: null, screen: null,
  shownAt: (typeof document !== 'undefined' && document.visibilityState === 'hidden') ? 0 : Date.now(),
  active: 0,             // ms in front of the student before the current stretch
  errors: 0, errKeys: {},
  screens: 0,
  closed: false
};

function visitActive() { return visit.active + (visit.shownAt ? Date.now() - visit.shownAt : 0); }

/* Which material this page is. A material page knows it from its own path or from the review
 * log's first answer; the hub is 'hub'. view.html hands the material its ?m= address. */
function pageMaterial() {
  if (visit.material) return visit.material;
  var found = null;
  try { var q = new URLSearchParams(location.search).get('m'); if (q && /^[\w-]+\/[\w-]+$/.test(q)) found = q; } catch (e) {}
  if (!found) { try { var p = location.pathname.match(/\/m\/([\w-]+)\/([\w-]+)\.html$/); if (p) found = p[1] + '/' + p[2]; } catch (e) {} }
  if (!found) {
    try {
      if (window.parent && window.parent !== window) {
        var pq = new URLSearchParams(window.parent.location.search).get('m');
        if (pq && /^[\w-]+\/[\w-]+$/.test(pq)) found = pq;
      }
    } catch (e) {}
  }
  if (!found && defaultNamespace === 'hub') found = 'hub';
  if (!found) { try { if (/\/study\/(index\.html)?$/.test(location.pathname)) found = 'hub'; } catch (e) {} }
  if (found) visit.material = found;
  return found;
}

function visitRead() {
  var raw = rawGet(VISIT_Q_KEY), q = [];
  try { q = raw ? JSON.parse(raw) : []; } catch (e) { q = []; }
  return Array.isArray(q) ? q : [];
}
function visitWrite(q) { try { rawSet(VISIT_Q_KEY, JSON.stringify(q)); } catch (e) {} }
function visitKey(e) { return e.p + '|' + e.k + '|' + e.t; }
function visitPersistNow() {
  clearTimeout(visitWriteT);
  if (!visitPending.length) return;
  var q = visitRead().concat(visitPending);
  visitPending = [];
  if (q.length > VISIT_MAX) q.splice(0, q.length - VISIT_MAX);
  visitWrite(q);
}
var lastVisitT = 0;
function visitLog(kind, data, now) {
  if (!telemetryEnabled()) return;
  var t = now || Date.now();
  if (t <= lastVisitT) t = lastVisitT + 1;   // two events of one kind never share a millisecond
  lastVisitT = t;
  var ev = { p: PAGE_ID, k: kind, t: t, m: pageMaterial() };
  if (data) ev.d = data;
  visitPending.push(ev);
  clearTimeout(visitWriteT);
  /* A page going away has no two seconds to spare. */
  if (kind === 'hide' || kind === 'close' || kind === 'error') visitPersistNow();
  else visitWriteT = setTimeout(visitPersistNow, 2000);
}

function visitFigures() {
  var d = { act: Math.round(visitActive() / 1000), dur: Math.round((Date.now() - PAGE_T0) / 1000), n: visit.answers };
  if (visit.answers) d.ok = visit.right;
  if (visit.lastStep) d.step = visit.lastStep;
  if (visit.screen) d.scr = visit.screen;
  return d;
}

/* The browser, described coarsely enough that it names nobody: operating system and browser
 * with their major versions, the app a link was opened inside, phone or tablet or computer,
 * Home Screen or not, screen size, time zone and language. Two installs that match on all of
 * it and never overlap in time are probably one browser that was wiped. */
var PROFILE_CACHE = null;
var persistedFlag = null;
try {
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(function (v) { persistedFlag = !!v; }, function () {});
  }
} catch (e) {}

function parseAgent(ua, touch) {
  var o = { os: 'other', osv: null, br: 'other', brv: null, app: null, kind: 'desktop' };
  var m;
  var ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  if (/iPhone|iPod/.test(ua) || ipad) {
    o.os = ipad ? 'ipados' : 'ios';
    m = ua.match(/OS (\d+)[_.]/); if (m) o.osv = +m[1];
    o.kind = ipad ? 'tablet' : 'phone';
  } else if (/Android/.test(ua)) {
    o.os = 'android';
    m = ua.match(/Android (\d+)/); if (m) o.osv = +m[1];
    o.kind = /Mobile/.test(ua) ? 'phone' : 'tablet';
  } else if (/CrOS/.test(ua)) { o.os = 'chromeos'; }
  else if (/Windows/.test(ua)) { o.os = 'windows'; }
  else if (/Macintosh|Mac OS X/.test(ua)) { o.os = 'mac'; }
  else if (/Linux/.test(ua)) { o.os = 'linux'; }

  var apps = [
    ['snapchat', /Snapchat/i], ['instagram', /Instagram/], ['tiktok', /musical_ly|BytedanceWebview|TikTok/i],
    ['messenger', /FBAN\/Messenger|FB_IAB\/MESSENGER/], ['facebook', /FBAN|FBAV|FB_IAB/], ['discord', /Discord/],
    ['google', /\bGSA\//], ['line', /\bLine\//], ['twitter', /Twitter/i], ['linkedin', /LinkedInApp/],
    ['classroom', /Classroom/i], ['teams', /Teams\//]
  ];
  for (var i = 0; i < apps.length; i++) if (apps[i][1].test(ua)) { o.app = apps[i][0]; break; }

  if ((m = ua.match(/EdgiOS\/(\d+)|Edg(?:A)?\/(\d+)/))) { o.br = 'edge'; o.brv = +(m[1] || m[2]); }
  else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) { o.br = 'samsung'; o.brv = +m[1]; }
  else if ((m = ua.match(/OPR\/(\d+)|OPiOS\/(\d+)/))) { o.br = 'opera'; o.brv = +(m[1] || m[2]); }
  else if ((m = ua.match(/CriOS\/(\d+)/))) { o.br = 'chrome'; o.brv = +m[1]; }
  else if ((m = ua.match(/FxiOS\/(\d+)|Firefox\/(\d+)/))) { o.br = 'firefox'; o.brv = +(m[1] || m[2]); }
  else if ((m = ua.match(/Chrome\/(\d+)/))) { o.br = 'chrome'; o.brv = +m[1]; }
  else if ((m = ua.match(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/))) { o.br = 'safari'; o.brv = +m[1]; }
  else if ((o.os === 'ios' || o.os === 'ipados') && !/Safari\//.test(ua)) { o.br = 'webview'; }
  if (o.app && o.br === 'other') o.br = 'webview';
  return o;
}

function deviceProfile() {
  var p = PROFILE_CACHE;
  if (!p) {
    p = {};
    try {
      var a = parseAgent(navigator.userAgent || '', navigator.maxTouchPoints || 0);
      for (var k in a) if (a[k] !== null) p[k] = a[k];
    } catch (e) {}
    try {
      var w = Math.round(screen.width), h = Math.round(screen.height);
      p.scr = Math.min(w, h) + 'x' + Math.max(w, h);
      p.dpr = Math.round((window.devicePixelRatio || 1) * 10) / 10;
    } catch (e) {}
    try { p.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) {}
    try { p.lang = (navigator.language || '').slice(0, 12) || null; } catch (e) {}
    try { p.local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(location.hostname) || location.protocol === 'file:'; } catch (e) {}
    PROFILE_CACHE = p;
  }
  var out = {};
  for (var k2 in p) if (p[k2] !== null && p[k2] !== undefined) out[k2] = p[k2];
  try {
    out.standalone = !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
  } catch (e) {}
  if (persistedFlag !== null) out.persisted = persistedFlag;
  /* The owner's own browsers say so, which is how the owner's devices label themselves. */
  try { out.owner = !!rawGet(STORE_PREFIX + 'auth:token') && rawGet(STORE_PREFIX + 'auth:role') === 'admin'; } catch (e) {}
  var im = readIdMeta();
  if (im) {
    out.id = im.how || 'ls';
    if (im.born) out.born = im.born;
    if (im.prior && im.prior.length) out.prior = im.prior.slice(0, 3);
  }
  var person = personId();
  if (person) out.person = person;
  return out;
}

/* A random id that syncs with the save code, so two paired devices end up sharing it. It is
 * minted on the device, never derived from the code, and written through the store like any
 * synced key, so a paired device picks it up on its next merge (the later write wins, and
 * both then agree). */
function personId() {
  var raw = rawGet(storageKey(PERSON_KEY_NS, PERSON_KEY)), v = null;
  try { v = raw ? JSON.parse(raw) : null; } catch (e) { v = null; }
  if (typeof v === 'string' && /^[0-9a-z]{12,40}$/.test(v)) return v;
  v = randomHex(10);
  try {
    rawSet(storageKey(PERSON_KEY_NS, PERSON_KEY), JSON.stringify(v));
    var meta = readMeta();
    meta.mtimes[PERSON_KEY_NS + ':' + PERSON_KEY] = Date.now();
    writeMeta(meta);
    if (meta.pairCode) { markDirty(); schedulePush(); }
  } catch (e) {}
  return v;
}

function visitFlush(useKeepalive) {
  visitPersistNow();
  if (visitBusy || visitUnavailable || !telemetryEnabled() || isLocalTest()) return Promise.resolve(0);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || isOffline()) return Promise.resolve(0);
  visitBusy = true;
  return idReady.then(function () {
    var batch = visitRead().slice(0, 150);
    return rpc('telemetry_events', { p_install: installId(), p_device: deviceProfile(), p_events: batch }, !!useKeepalive)
      .then(function (r) {
        if (r && r.ok === false && r.error === 'rejected') return 0;
        var done = {};
        for (var i = 0; i < batch.length; i++) done[visitKey(batch[i])] = true;
        visitWrite(visitRead().filter(function (e) { return !done[visitKey(e)]; }));
        return batch.length;
      });
  }).then(function (n) { visitBusy = false; return n; }, function (err) {
    visitBusy = false;
    if (err && (err.status === 404 || err.status === 400)) visitUnavailable = true;
    return 0;
  });
}

/* ---- per material counts on this device: what the nudge and the check in need ---- */
function seenRead() {
  var v = null;
  try { v = JSON.parse(rawGet(SEEN_KEY) || 'null'); } catch (e) { v = null; }
  return v && typeof v === 'object' ? v : {};
}
function seenWrite(v) { try { rawSet(SEEN_KEY, JSON.stringify(v)); } catch (e) {} }

/* Steps that teach rather than test. A student who has touched any of these has found the
 * teaching part, so the rough start suggestion has nothing to offer them. */
var TEACH_STEP = /^(learn|lesson|teach|lad|worked|rule|concept|guide|read|skill)/;
var NUDGE_AFTER = 8;

function visitOnReview(ev) {
  try {
    if (!ev || !ev.m) return;
    if (!visit.material || visit.material === 'hub') visit.material = String(ev.m);
    var ok = typeof ev.ok === 'boolean' ? ev.ok : (+ev.g > 1);
    visit.answers++;
    if (ok) visit.right++;
    visit.lastStep = String(ev.k || '').slice(0, 20) || null;

    var all = seenRead(), s = all[ev.m];
    if (!s) {
      /* A device that studied this material before these counts existed is not starting out:
         it gets no rough start suggestion. */
      s = all[ev.m] = { n: 0, first: [], teach: studiedCards(defaultNamespace) > 1 };
    }
    s.n++;
    if (TEACH_STEP.test(String(ev.k || ''))) s.teach = true;
    else if (s.first.length < NUDGE_AFTER) s.first.push(ok ? 1 : 0);
    seenWrite(all);

    if (!s.teach && !s.nudged && !NO_NUDGE[ev.m] && s.first.length === NUDGE_AFTER) {
      var right = s.first.reduce(function (a, b) { return a + b; }, 0);
      if (right < NUDGE_AFTER / 2) { s.nudged = Date.now(); seenWrite(all); showNudge(String(ev.m), right); }
    }
  } catch (e) {}
}

/* ---- the screen a material is on ----
 * Materials already save which tab is open in their 'ui' key. The short text fields that name
 * a tab are read from it as the screen; nothing else in 'ui' is looked at. */
var SCREEN_FIELDS = ['tab', 'view', 'mode', 'screen', 'page', 'route', 'pane'];
function visitOnUi(value) {
  try {
    if (!value || typeof value !== 'object') return;
    var name = null;
    for (var i = 0; i < SCREEN_FIELDS.length; i++) {
      var v = value[SCREEN_FIELDS[i]];
      if (typeof v === 'string' && v && v.length <= 24) { name = v; break; }
    }
    if (!name || name === visit.screen) return;
    visit.screen = name;
    if (visit.screens++ < 60) visitLog('screen', { scr: name });
  } catch (e) {}
}

/* ---- errors ---- */
function cleanText(s, n) {
  return String(s || '').replace(/https?:\/\/[^\s)'"]+/g, function (u) {
    try { var x = new URL(u); return x.pathname.split('/').pop() || x.host; } catch (e) { return 'url'; }
  }).replace(/\s+/g, ' ').slice(0, n || 200);
}
function visitError(msg, file, line, col) {
  try {
    var key = cleanText(msg, 120) + '|' + line;
    if (visit.errKeys[key] || visit.errors >= 5) return;
    visit.errKeys[key] = 1;
    visit.errors++;
    var f = '';
    try { f = file ? (String(file).indexOf('blob:') === 0 ? 'blob' : new URL(file, location.href).pathname.split('/').pop()) : ''; } catch (e) { f = ''; }
    visitLog('error', { msg: cleanText(msg), file: f.slice(0, 60), line: line || null, col: col || null, scr: visit.screen || null, n: visit.answers });
  } catch (e) {}
}

/* ---- a small sheet for the nudge and the check in ----
 * Drawn in a shadow root so no material's styles reach it, in the material's own colours
 * (read from the page at the moment it is shown), and keyboard friendly: 1 to 4 pick, Escape
 * closes. While it is open those keys belong to it and do not reach the material. */
var sheetOpen = null;
function pageColors() {
  var bg = '#ffffff', fg = '#111111';
  try {
    var cs = getComputedStyle(document.body);
    var b = cs.backgroundColor, c = cs.color;
    if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) bg = b;
    else { var ch = getComputedStyle(document.documentElement).backgroundColor; if (ch && !/rgba\(0, 0, 0, 0\)|transparent/.test(ch)) bg = ch; }
    if (c) fg = c;
  } catch (e) {}
  return { bg: bg, fg: fg };
}
function showSheet(opts) {
  if (sheetOpen || typeof document === 'undefined' || !document.body) return null;
  var host = document.createElement('div');
  host.setAttribute('data-studyhub-sheet', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var col = pageColors();
  var css =
    ':host{all:initial}' +
    '.wrap{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:center;padding:0 16px calc(16px + env(safe-area-inset-bottom));z-index:2147483000;pointer-events:none}' +
    '.card{pointer-events:auto;box-sizing:border-box;width:100%;max-width:440px;background:' + col.bg + ';color:' + col.fg + ';' +
      'border:1px solid color-mix(in srgb,' + col.fg + ' 18%,transparent);border-radius:16px;padding:16px 16px 14px;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.18);font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}' +
    '.t{font-weight:600;font-size:16px;margin:0 32px 4px 0}' +
    '.b{margin:0 0 12px;opacity:.78}' +
    '.row{display:flex;flex-wrap:wrap;gap:8px}' +
    'button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,' + col.fg + ' 26%,transparent);' +
      'border-radius:12px;min-height:44px;padding:0 14px;cursor:pointer;display:inline-flex;align-items:center;gap:8px}' +
    'button.main{background:' + col.fg + ';color:' + col.bg + ';border-color:' + col.fg + '}' +
    'button kbd{font:600 12px/1 inherit;opacity:.6}' +
    '.x{position:absolute;top:8px;right:8px;border:0;min-height:40px;width:40px;padding:0;justify-content:center;font-size:20px;opacity:.6}' +
    '.in{display:flex;gap:8px;align-items:center;margin-top:10px}' +
    'input{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,' + col.fg + ' 26%,transparent);' +
      'border-radius:10px;min-height:40px;padding:0 10px;width:8.5em;box-sizing:border-box}' +
    '.card{position:relative}' +
    '@media (hover:hover){button:hover{border-color:' + col.fg + '}}' +
    'button:focus-visible,input:focus-visible{outline:2px solid ' + col.fg + ';outline-offset:2px}';
  var style = document.createElement('style');
  style.textContent = css;
  var wrap = document.createElement('div'); wrap.className = 'wrap';
  var card = document.createElement('div'); card.className = 'card';
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', opts.title);
  var t = document.createElement('p'); t.className = 't'; t.textContent = opts.title;
  var b = document.createElement('p'); b.className = 'b'; b.textContent = opts.body;
  var x = document.createElement('button'); x.className = 'x'; x.type = 'button';
  x.setAttribute('aria-label', 'Close'); x.textContent = '×';
  var row = document.createElement('div'); row.className = 'row';
  card.appendChild(x); card.appendChild(t); card.appendChild(b); card.appendChild(row);
  var input = null;
  if (opts.input) {
    var inRow = document.createElement('label'); inRow.className = 'in';
    var lab = document.createElement('span'); lab.textContent = opts.input; lab.style.opacity = '.78';
    input = document.createElement('input'); input.type = 'text'; input.maxLength = 12;
    input.inputMode = 'text'; input.autocomplete = 'off'; input.placeholder = opts.placeholder || '';
    inRow.appendChild(lab); inRow.appendChild(input);
    card.appendChild(inRow);
  }
  wrap.appendChild(card);
  root.appendChild(style); root.appendChild(wrap);

  var done = false;
  function close(choice) {
    if (done) return;
    done = true;
    sheetOpen = null;
    window.removeEventListener('keydown', onKey, true);
    try { host.remove(); } catch (e) {}
    try { opts.onClose(choice, input ? input.value.trim().slice(0, 12) : ''); } catch (e) {}
  }
  opts.choices.forEach(function (c, i) {
    var btn = document.createElement('button');
    btn.type = 'button';
    if (c.main) btn.className = 'main';
    var k = document.createElement('kbd'); k.textContent = String(i + 1);
    btn.appendChild(k); btn.appendChild(document.createTextNode(c.label));
    btn.addEventListener('click', function () { close(c.id); });
    row.appendChild(btn);
  });
  x.addEventListener('click', function () { close('dismiss'); });
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close('dismiss'); return; }
    var inInput = input && (root.activeElement === input);
    if (inInput) { if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); } return; }
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= opts.choices.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopImmediatePropagation(); close(opts.choices[n - 1].id);
    }
  }
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(host);
  sheetOpen = host;
  return host;
}

/* ---- the rough start suggestion ----
 * Eight answers in, if fewer than half were right and none of them came from the teaching
 * part, point at the teaching part once. A material can say where that is with
 * StudyStore.visit.teach({ label, go }); otherwise a tab whose text is one of TEACH_LABELS is
 * looked for and clicked. With neither, the sheet only says it. */
var teachRoute = null;
/* Where each live material teaches, by its tab id (every core material has a global
 * selectTab) and the label on that tab. Searching labels alone was wrong for materials whose
 * "For you" is the practice feed: Crucible 1 and 2 and psychology teach in their Guide.
 * Vocabulary and the periodic table are left out: vocabulary's feed already teaches each word
 * before testing it, and the periodic table has no teaching part to point at. */
var TEACH_ROUTES = {
  'apush/period1-2-test': ['Learn', 'learn'],
  'apush/ch5-saq': ['Lessons', 'lessons'],
  'la10/crucible-3-4': ['For you', 'home'],
  'la10/crucible-1-2': ['Guide', 'guide'],
  'other/psych-unit0': ['Guide', 'guide'],
  'fr/chateaux': ['Les mots', 'mots']
};
var NO_NUDGE = { 'la10/vocab-ch1': true, 'chem/periodic-table': true };
var TEACH_LABELS = ['Learn', 'Lessons', 'Lesson', 'Guide', 'Teach', 'Study guide'];
function clickLabel(label) {
  try {
    var els = document.querySelectorAll('button, a, [role="tab"]');
    for (var i = 0; i < els.length; i++) {
      var txt = (els[i].textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (txt === label.toLowerCase() && els[i].offsetParent !== null) { els[i].click(); return true; }
    }
  } catch (e) {}
  return false;
}
function findTeachTab(material) {
  var r = TEACH_ROUTES[material];
  if (r) {
    return { label: r[0], go: function () {
      if (typeof window.selectTab === 'function') { try { window.selectTab(r[1]); return; } catch (e) {} }
      clickLabel(r[0]);
    } };
  }
  try {
    var els = document.querySelectorAll('button, a, [role="tab"]');
    for (var j = 0; j < TEACH_LABELS.length; j++) {
      for (var i = 0; i < els.length; i++) {
        var txt = (els[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (txt.toLowerCase() === TEACH_LABELS[j].toLowerCase() && els[i].offsetParent !== null) {
          return { label: TEACH_LABELS[j], go: (function (el) { return function () { el.click(); }; })(els[i]) };
        }
      }
    }
  } catch (e) {}
  return null;
}
function showNudge(material, right) {
  var route = teachRoute || findTeachTab(material);
  var place = route ? 'the ' + route.label + ' tab' : 'the teaching part of this material';
  var choices = route
    ? [{ id: 'go', label: 'Open ' + route.label, main: true }, { id: 'stay', label: 'Keep going' }]
    : [{ id: 'stay', label: 'Got it', main: true }];
  setTimeout(function () {
    var shown = showSheet({
      title: right + ' of your first ' + NUDGE_AFTER + ' right',
      body: 'That is a hard way to start. ' + (route ? 'Try ' + place + ' first: it' : 'This material has a part that') +
        ' goes through each idea before it tests you, and the practice will make more sense after it.',
      choices: choices,
      onClose: function (choice) {
        visitLog('nudge', { right: right, of: NUDGE_AFTER, to: route ? route.label : null, pick: choice });
        if (choice === 'go' && route) { try { route.go(); } catch (e) {} }
      }
    });
    if (!shown) visitLog('nudge', { right: right, of: NUDGE_AFTER, pick: 'blocked' });
  }, 1200);
}

/* ---- the after the quiz check in ----
 * The only number that says whether the hub helps is how the quiz went. A material that keeps
 * its quiz date (the core engine's 'fsrs' record) asks once, one to four days after it, on a
 * device that answered at least ten questions in it. One tap, an optional score, or skip. */
function quizDateOf(ns) {
  try {
    var v = JSON.parse(rawGet(storageKey(ns, 'fsrs')) || 'null');
    var d = v && typeof v.quizDate === 'string' ? v.quizDate : null;
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch (e) { return null; }
}
/* Cards this device has answered at least once in a core material, from its own record. */
function studiedCards(ns) {
  try {
    var v = JSON.parse(rawGet(storageKey(ns, 'fsrs')) || 'null'), n = 0;
    var cards = v && v.cards && typeof v.cards === 'object' ? v.cards : {};
    for (var k in cards) if (cards[k] && cards[k].reps > 0) n++;
    return n;
  } catch (e) { return 0; }
}
function daysSince(isoDay) {
  var p = isoDay.split('-');
  var q = new Date(+p[0], +p[1] - 1, +p[2]).getTime();
  var n = new Date(); n = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  return Math.round((n - q) / 864e5);
}
function maybeCheckin() {
  try {
    var ns = defaultNamespace, m = pageMaterial();
    if (!ns || !m || m === 'hub' || !telemetryEnabled()) return;
    var qd = quizDateOf(ns);
    if (!qd) return;
    var ago = daysSince(qd);
    if (ago < 1 || ago > 4) return;
    var all = seenRead(), s = all[m] || {};
    if (Math.max(s.n || 0, studiedCards(ns)) < 10 || (s.checkin && s.checkin[qd])) return;
    var title = (document.title || '').split(/\s[|·:]\s/)[0].trim().slice(0, 60);
    showSheet({
      title: 'How did the quiz go?',
      body: (title ? title + ', ' : '') + (ago === 1 ? 'yesterday' : ago + ' days ago') +
        '. One tap helps work out what actually helps. It is anonymous.',
      choices: [
        { id: 'well', label: 'Well' }, { id: 'ok', label: 'Okay' },
        { id: 'rough', label: 'Rough' }, { id: 'none', label: 'Did not take it' }
      ],
      input: 'Score, if you know it', placeholder: 'like 8/10',
      onClose: function (choice, score) {
        var again = seenRead(), s2 = again[m] || (again[m] = { n: 0, first: [], teach: false });
        s2.checkin = s2.checkin || {};
        s2.checkin[qd] = choice;
        seenWrite(again);
        var d = { r: choice, qd: qd, ago: ago, n: s2.n };
        if (score && /^[\d\s./%a-zA-Z+-]{1,12}$/.test(score)) d.score = score;
        visitLog('checkin', d);
        visitFlush();
      }
    });
  } catch (e) {}
}

function visitStart() {
  if (!telemetryEnabled()) return;
  var ref = null;
  try {
    if (document.referrer) {
      var r = new URL(document.referrer);
      ref = r.host === location.host ? 'self' : r.host.replace(/^www\./, '').slice(0, 60);
    }
  } catch (e) {}
  var nav = null;
  try { var ne = performance.getEntriesByType('navigation')[0]; nav = ne ? ne.type : null; } catch (e) {}
  visitLog('open', { ref: ref, nav: nav }, PAGE_T0);

  try {
    window.addEventListener('error', function (e) {
      if (e && e.message) visitError(e.message, e.filename, e.lineno, e.colno);
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      visitError('unhandled rejection: ' + (r && r.message ? r.message : String(r)), r && r.fileName, r && r.lineNumber);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        if (visit.shownAt) { visit.active += Date.now() - visit.shownAt; visit.shownAt = 0; }
        visitLog('hide', visitFigures());
        visitFlush(true);
      } else {
        visit.shownAt = Date.now();
        visitLog('show', null);
        visitFlush();
      }
    });
    window.addEventListener('pagehide', function () {
      if (visit.closed) return;
      visit.closed = true;
      if (visit.shownAt) { visit.active += Date.now() - visit.shownAt; visit.shownAt = 0; }
      visitLog('close', visitFigures());
      visitFlush(true);
    });
    window.addEventListener('online', function () { visitFlush(); });
    setInterval(function () { visitFlush(); }, TELEMETRY_FLUSH_MS);
  } catch (e) {}
  setTimeout(function () { visitFlush(); }, 9000);
  setTimeout(maybeCheckin, 2500);
}

/* -------------------------------------------------- other tabs */
/* The hub and a material can be open side by side, and a sync in one writes progress the
 * other is holding in memory. Without this the material kept its stale copy and wrote it
 * straight back over what had just merged in. localStorage announces writes from other
 * tabs, so they are turned into the same 'change' events a sync in this tab would raise. */
function watchOtherTabs() {
  try {
    window.addEventListener('storage', function (e) {
      if (!e || !e.key || e.key.indexOf(STORE_PREFIX) !== 0) return;
      if (e.key === META_KEY || e.key === DIRTY_KEY || e.newValue === null) return;
      var full = e.key.slice(STORE_PREFIX.length);
      var split = full.indexOf(':');
      if (split <= 0) return;
      var ns = full.slice(0, split), key = full.slice(split + 1);
      if (isExcluded(ns, key)) return;
      var value;
      try { value = JSON.parse(e.newValue); } catch (err) { return; }
      memFallback[e.key] = e.newValue;
      emit('change', { ns: ns, key: key, value: value });
    });
  } catch (e) {}
}

/* -------------------------------------------------- public API */

var StudyStore = {
  init: function (opts) {
    opts = opts || {};
    if (opts.namespace) defaultNamespace = String(opts.namespace);
    if (opts.supabaseUrl) SUPABASE_URL = String(opts.supabaseUrl);
    if (opts.anonKey) SUPABASE_ANON_KEY = String(opts.anonKey);
    if (initialized) return StudyStore;
    initialized = true;

    adoptOrphanMtimes();
    registerServiceWorker();
    telemetryStart();
    visitStart();
    watchOtherTabs();

    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') syncNow('visible');
        else finalFlush();
      });
      window.addEventListener('online', function () { syncNow('online'); });
      window.addEventListener('offline', function () {
        setState('offline', 'No connection: changes are saved here and will send themselves.');
        scheduleRetry();          // the browser may simply be wrong
      });
      window.addEventListener('pagehide', finalFlush);
    } catch (e) {}

    if (looksOffline()) setState('offline', 'No connection: changes are saved here and will send themselves.');
    syncNow('load');   // try regardless; the attempt is what tells us the truth
    return StudyStore;
  },

  get: function (key) {
    var ns = defaultNamespace;
    if (!ns) return Promise.resolve(null);
    var raw = rawGet(storageKey(ns, key));
    if (raw === null) return Promise.resolve(null);
    try { return Promise.resolve(JSON.parse(raw)); }
    catch (e) { return Promise.resolve(null); }
  },

  set: function (key, value) {
    var ns = defaultNamespace;
    if (!ns) return Promise.resolve(false);
    try {
      var marksMoved = false;
      if (key === 'ui' && SYNC_PARTIAL[ns]) {
        var before = null;
        try { before = JSON.parse(rawGet(storageKey(ns, key)) || 'null'); } catch (e0) { before = null; }
        marksMoved = partialOf(ns, before) !== partialOf(ns, value);
      }
      rawSet(storageKey(ns, key), JSON.stringify(value));
      if (key === 'ui') visitOnUi(value);
      var meta = readMeta();
      meta.mtimes[ns + ':' + key] = Date.now();
      if (marksMoved) meta.mtimes[ns + ':' + SYNC_PARTIAL_KEY] = Date.now();
      writeMeta(meta);
      if (!isExcluded(ns, key) || marksMoved) {
        markDirty();
        schedulePush();
      }
    } catch (e) {}
    return Promise.resolve(true);
  },

  registerMerge: function (ns, key, fn) {
    if (typeof fn === 'function') MERGE_REGISTRY[ns + ':' + key] = fn;
    return StudyStore;
  },

  createPairCode: function () {
    var bytes = new Uint8Array(CODE_LEN);
    crypto.getRandomValues(bytes);
    var code = '';
    for (var i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET.charAt(bytes[i] & 31);
    var meta = readMeta();
    meta.pairCode = code;
    meta.seenUpdatedAt = null;
    writeMeta(meta);
    markDirty();
    syncNow('pair-create');
    return formatCode(code);
  },

  /* Resolves with { code, found }. found is false when the server holds nothing under that
   * code, which after a typo is the only clue: the sync itself succeeds either way, it just
   * starts a fresh row that the other device will never see. null means it could not be
   * checked (offline); the code is kept and tried again. */
  pair: function (input) {
    var code = normalizeCode(input);   // throws with a readable message on bad input
    var meta = readMeta();
    meta.pairCode = code;
    meta.seenUpdatedAt = null;
    writeMeta(meta);
    markDirty();
    var probe = (SUPABASE_URL && SUPABASE_ANON_KEY && !isOffline())
      ? rpcPull(code).then(function (r) { return !!(r && r.found); }, function () { return null; })
      : Promise.resolve(null);
    return probe.then(function (found) {
      return syncNow('pair').then(function () { return { code: formatCode(code), found: found }; });
    });
  },

  unpair: function () {
    var meta = readMeta();
    meta.pairCode = null;
    meta.seenUpdatedAt = null;
    meta.lastSyncedAt = null;
    writeMeta(meta);
    setState('idle', '');
    return StudyStore;
  },

  status: statusSnapshot,

  on: function (evt, cb) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(cb);
    if (evt === 'status') { try { cb(statusSnapshot()); } catch (e) {} }
    return function off() {
      var i = listeners[evt].indexOf(cb);
      if (i !== -1) listeners[evt].splice(i, 1);
    };
  },

  telemetry: {
    enabled: telemetryEnabled,
    setEnabled: telemetrySetEnabled,
    record: telemetryRecord,
    flush: telemetryFlush,
    pending: telemetryPendingCount,
    /* True once this page load has been told the server has no ingest function. The hub
       shows it, because a queue that only ever grows looks exactly like one that is
       waiting for a connection, and the owner is the one who can fix it. */
    unavailable: function () { return telemetryUnavailable; },
    installId: installId
  },

  /* The visit diary (see "visits" above). teach() tells the rough start suggestion where the
     material's teaching part is: { label: 'Learn', go: function () { ... } }. screen() names
     the screen when a material does not keep a tab name in 'ui'. */
  visit: {
    teach: function (route) {
      if (route && typeof route.go === 'function') teachRoute = { label: String(route.label || 'Learn').slice(0, 24), go: route.go };
      return StudyStore;
    },
    screen: function (name) { visitOnUi({ screen: String(name || '').slice(0, 24) }); return StudyStore; },
    flush: visitFlush,
    pending: function () { return visitRead().length + visitPending.length; },
    profile: deviceProfile,
    checkin: maybeCheckin
  },
  exportCode: exportCode,
  previewImport: previewImport,
  importCode: function (str) {
    return previewImport(str).then(function (p) { p.commit(); return p; });
  },

  syncNow: syncNow,
  syncSummary: syncSummary,

  _debug: {
    setOffline: function (v) {
      FORCE_OFFLINE = !!v;
      if (FORCE_OFFLINE) setState('offline', 'Offline: changes saved on this device.');
      else syncNow('debug-online');
      return FORCE_OFFLINE;
    },
    buildEnvelope: buildEnvelope,
    applyEnvelope: applyEnvelope,
    readMeta: readMeta,
    mergeEnvelopes: mergeEnvelopes,
    registry: MERGE_REGISTRY
  }
};

window.StudyStore = StudyStore;

})();
