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
var PUSH_THROTTLE_MS = 25000;
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
  /* 'telemetryQueue' and 'installId' are per device by definition: copying a queue between
   * devices would send the same reviews twice, and the install id is what keeps one
   * device's stream separable from another's without naming anybody. The 'telemetry'
   * preference itself DOES sync, because a decision about your own data should hold
   * everywhere you study rather than needing to be made again on each device. */
  'hub': ['recent', 'telemetryQueue', 'installId']
};

/* Whole namespaces that never leave the device, whatever the key. 'auth' holds the session
 * token, the role, the cached decryption keys and the cached catalog: credentials and
 * server state, not progress. They share the store prefix, so without this they were swept
 * into the envelope like everything else. That carried an owner sign-in onto every paired
 * device, parked material keys in the sync row, and undid every sign-out: the next merge
 * found the keys on the server and put them back. */
var SYNC_EXCLUDE_NS = { 'auth': true };

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
function pickStateRecord(a, b) {
  var aLast = (a && typeof a.last === 'number') ? a.last : 0;
  var bLast = (b && typeof b.last === 'number') ? b.last : 0;
  if (aLast > bLast) return a;
  if (bLast > aLast) return b;
  var aReps = (a && typeof a.reps === 'number') ? a.reps : 0;
  var bReps = (b && typeof b.reps === 'number') ? b.reps : 0;
  if (aReps > bReps) return a;
  if (bReps > aReps) return b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

/* Event logs all merge the same way: concatenate, dedupe by timestamp, keep the newest N.
 * The cap is a parameter because the two histories want different depths. Practice runs
 * share one 20-slot log, but graded tests are rarer and worth more, so they keep 40: a
 * week of drilling should not be able to evict a test result. */
function makeEventMerge(cap) {
  return function (aEx, bEx) {
  var all = [].concat(Array.isArray(aEx) ? aEx : [], Array.isArray(bEx) ? bEx : []);
  var byTs = {};
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (!e || typeof e.ts === 'undefined') continue;
    var k = String(e.ts);
    var prev = byTs[k];
    if (!prev) { byTs[k] = e; continue; }
    // Same timestamp from both sides: prefer a pass, then break ties deterministically.
    if (!prev.exact && e.exact) byTs[k] = e;
    else if (prev.exact === e.exact && canonicalJson(e) > canonicalJson(prev)) byTs[k] = e;
  }
  var out = [];
  for (var key in byTs) if (Object.prototype.hasOwnProperty.call(byTs, key)) out.push(byTs[key]);
  out.sort(function (x, y) { return x.ts - y.ts; });
  return out.slice(-cap);
  };
}
var mergeExams = makeEventMerge(20);

/* Every spaced-repetition material shares one shape: a map of records keyed by whatever
   it drills, plus exams and a quiz date. Only the name of that map differs, so the rule
   is written once and bound to each material's field. */
function makeFsrsMerge(mapField) {
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
        ? pickStateRecord(aMap[name], bMap[name])
        : bMap[name];
    }

    var quizDate;
    if (aM > bM) quizDate = a.quizDate;
    else if (bM > aM) quizDate = b.quizDate;
    else if (a.quizDate && !b.quizDate) quizDate = a.quizDate;
    else if (b.quizDate && !a.quizDate) quizDate = b.quizDate;
    else quizDate = (String(a.quizDate) >= String(b.quizDate)) ? a.quizDate : b.quizDate;

    var merged = { quizDate: typeof quizDate === 'undefined' ? null : quizDate,
                   exams: mergeExams(a.exams, b.exams) };
    merged[mapField] = out;
    return merged;
  };
}

var mergeFsrsValue  = makeFsrsMerge('states');   // fifty-states
var mergeCardsFsrs  = makeFsrsMerge('cards');    // periodic table, Fraser reading quiz

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

/* Material-specific merges that the HUB also needs live here rather than being registered
 * by the material. The hub merges on load, on visibility and during import preview, all
 * while the quiz page may be closed. See README, "Adding a material". */
var BUILTIN_MERGES = {
  'fifty-states:fsrs': mergeFsrsValue,
  'fifty-states:regionsDone': mergeRegionsDone,
  'periodic:fsrs': mergeCardsFsrs,
  /* The Fraser reading quiz schedules both its quiz questions and its names, and stores
   * them in the same { cards, quizDate, exams } shape, so it reuses the rule rather than
   * defining a third one. Without this entry a phone's reviews would be overwritten
   * wholesale by whichever device wrote last. */
  'fraser12:fsrs': mergeCardsFsrs,
  'periodic:setsDone': mergeRegionsDone,     // legacy ids; kept so an old device loses nothing
  'periodic:started': mergeNumberSet,        // set-size-independent successor to setsDone
  'periodic:settings': mergeSettings,
  'periodic:tests': makeEventMerge(40)
};

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
      var fn = reg[nsName + ':' + k] || defaultMerge;
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
    mergeFsrsValue: mergeFsrsValue,
    mergeCardsFsrs: mergeCardsFsrs,
    makeFsrsMerge: makeFsrsMerge,
    mergeRegionsDone: mergeRegionsDone,
    mergeNumberSet: mergeNumberSet,
    mergeSettings: mergeSettings,
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
  return { entries: entries, mtimes: meta.mtimes };
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
function finalFlush() {
  if (!canSync() || !isDirty() || isOffline()) return;
  var meta = readMeta();
  var env = buildEnvelope();
  var body = JSON.stringify(env);
  if (body.length > KEEPALIVE_LIMIT) return;
  try { rpcPush(meta.pairCode, env, meta.seenUpdatedAt, true).catch(function () {}); } catch (e) {}
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
 * anyone having to be identified. It is not tied to a person, a code or a session, and
 * clearing site data throws it away for good. */
function installId() {
  var id = rawGet(TEL_ID_KEY);
  if (id) return id;
  var bytes;
  try {
    bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  } catch (e) {
    id = 'x' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  rawSet(TEL_ID_KEY, id);
  return id;
}

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

function telemetryRecord(ev) {
  if (!telemetryEnabled() || !ev || typeof ev !== 'object') return;
  telemetryPending.push(ev);
  telemetryPersist();
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
function telemetryFlush(useKeepalive) {
  if (telemetryBusy || telemetryUnavailable || !telemetryEnabled()) return Promise.resolve(0);
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

  return round(0, 0).then(finish).catch(function (err) {
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
      rawSet(storageKey(ns, key), JSON.stringify(value));
      var meta = readMeta();
      meta.mtimes[ns + ':' + key] = Date.now();
      writeMeta(meta);
      if (!isExcluded(ns, key)) {
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
  exportCode: exportCode,
  previewImport: previewImport,
  importCode: function (str) {
    return previewImport(str).then(function (p) { p.commit(); return p; });
  },

  syncNow: syncNow,

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
