/* StudyStore — shared local-first storage + sync for every Study Hub material.
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
 * CONFIG — the only lines you edit to turn sync on.
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
 * 'followFocus' is a view preference: a phone and a laptop reasonably want different ones.
 * 'recent' is browser-history-like: meaningful per device, noise across devices. */
var SYNC_EXCLUDE = {
  'fifty-states': ['deck', 'followFocus'],
  'hub': ['recent']
};

/* Captured at parse time — document.currentScript is only valid while this script runs. */
var SCRIPT_URL = (typeof document !== 'undefined' && document.currentScript)
  ? document.currentScript.src
  : null;

/* ============================================================================
 * SECTION A — pure core. No window, no localStorage, no navigator, no fetch.
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
 * deterministic and side-symmetric — merge(a,b) and merge(b,a) must agree, or repeated
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

function mergeExams(aEx, bEx) {
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
  return out.slice(-20);
}

function mergeFsrsValue(aVal, bVal, aM, bM) {
  var a = aVal && typeof aVal === 'object' ? aVal : {};
  var b = bVal && typeof bVal === 'object' ? bVal : {};
  var aStates = a.states && typeof a.states === 'object' ? a.states : {};
  var bStates = b.states && typeof b.states === 'object' ? b.states : {};

  var states = {};
  var name;
  for (name in aStates) if (Object.prototype.hasOwnProperty.call(aStates, name)) states[name] = aStates[name];
  for (name in bStates) {
    if (!Object.prototype.hasOwnProperty.call(bStates, name)) continue;
    states[name] = Object.prototype.hasOwnProperty.call(aStates, name)
      ? pickStateRecord(aStates[name], bStates[name])
      : bStates[name];
  }

  var quizDate;
  if (aM > bM) quizDate = a.quizDate;
  else if (bM > aM) quizDate = b.quizDate;
  else if (a.quizDate && !b.quizDate) quizDate = a.quizDate;
  else if (b.quizDate && !a.quizDate) quizDate = b.quizDate;
  else quizDate = (String(a.quizDate) >= String(b.quizDate)) ? a.quizDate : b.quizDate;

  return {
    states: states,
    quizDate: typeof quizDate === 'undefined' ? null : quizDate,
    exams: mergeExams(a.exams, b.exams)
  };
}

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

/* Material-specific merges that the HUB also needs live here rather than being registered
 * by the material. The hub merges on load, on visibility and during import preview — all
 * while the quiz page may be closed. See README, "Adding a material". */
var BUILTIN_MERGES = {
  'fifty-states:fsrs': mergeFsrsValue,
  'fifty-states:regionsDone': mergeRegionsDone
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
  var list = SYNC_EXCLUDE[ns];
  return !!(list && list.indexOf(key) !== -1);
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
  var bs = b.states || {}, as = a.states || {};
  var added = 0, updated = 0, name;
  for (name in as) {
    if (!Object.prototype.hasOwnProperty.call(as, name)) continue;
    if (!Object.prototype.hasOwnProperty.call(bs, name)) added++;
    else if (!deepEqual(bs[name], as[name])) updated++;
  }
  var bEx = Array.isArray(b.exams) ? b.exams.length : 0;
  var aEx = Array.isArray(a.exams) ? a.exams.length : 0;
  var parts = [];
  if (added) parts.push(added + ' state' + (added === 1 ? '' : 's') + ' added');
  if (updated) parts.push(updated + ' state' + (updated === 1 ? '' : 's') + ' updated');
  if (aEx > bEx) parts.push((aEx - bEx) + ' exam result' + ((aEx - bEx) === 1 ? '' : 's') + ' added');
  if (b.quizDate !== a.quizDate) parts.push('quiz date set to ' + (a.quizDate || 'none'));
  return parts.length ? parts.join(', ') : 'no changes';
}

/* ============================================================================
 * SECTION B — Node export, so tests/merge.test.mjs can load the real code.
 * ========================================================================== */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeCode: normalizeCode,
    formatCode: formatCode,
    defaultMerge: defaultMerge,
    mergeFsrsValue: mergeFsrsValue,
    mergeRegionsDone: mergeRegionsDone,
    mergeExams: mergeExams,
    pickStateRecord: pickStateRecord,
    mergeEnvelopes: mergeEnvelopes,
    buildEnvelopeFrom: buildEnvelopeFrom,
    diffEnvelopes: diffEnvelopes,
    describeFsrsChange: describeFsrsChange,
    emptyEnvelope: emptyEnvelope,
    deepEqual: deepEqual,
    canonicalJson: canonicalJson,
    SYNC_EXCLUDE: SYNC_EXCLUDE,
    BUILTIN_MERGES: BUILTIN_MERGES,
    CODE_ALPHABET: CODE_ALPHABET,
    CODE_LEN: CODE_LEN
  };
}

/* ============================================================================
 * SECTION C — browser wiring. Guarded so Node never reaches it.
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

function isDirty() { return rawGet(DIRTY_KEY) === '1'; }
function markDirty() { rawSet(DIRTY_KEY, '1'); }
function clearDirty() { rawRemove(DIRTY_KEY); }

function storageKey(ns, key) { return STORE_PREFIX + ns + ':' + key; }

/* Walks localStorage and rebuilds the sync envelope from whatever is actually there.
 * Reading the store rather than tracking writes means data written by a material's
 * no-StudyStore fallback path is picked up too — the key format is identical. */
function collectEntries() {
  var meta = readMeta();
  var entries = {};
  var keys = rawKeys();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!k || k.indexOf(STORE_PREFIX) !== 0) continue;
    if (k === META_KEY || k === DIRTY_KEY) continue;
    var full = k.slice(STORE_PREFIX.length);
    if (full.indexOf(':') <= 0) continue;
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
    if (full.indexOf(':') <= 0) continue;
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

function statusSnapshot() {
  var meta = readMeta();
  return {
    state: state.state,
    message: state.message,
    paired: !!meta.pairCode,
    codeDisplay: meta.pairCode ? formatCode(meta.pairCode) : null,
    configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
    lastSyncedAt: meta.lastSyncedAt,
    dirty: isDirty()
  };
}

function setState(next, message) {
  state.state = next;
  state.message = message || '';
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

function isOffline() {
  if (FORCE_OFFLINE) return true;
  try { return navigator.onLine === false; } catch (e) { return false; }
}

function syncNow(reason) {
  if (!canSync()) { setState('idle', ''); return Promise.resolve(false); }
  if (isOffline()) {
    setState('offline', 'Offline — changes saved on this device.');
    return Promise.resolve(false);
  }
  if (inFlight) { pendingAgain = true; return Promise.resolve(false); }

  inFlight = true;
  setState('syncing', 'Syncing…');
  var meta = readMeta();
  var code = meta.pairCode;

  function attempt(n, known) {
    // known = server row we already hold ({payload, updated_at}) or null to pull fresh.
    var step = known ? Promise.resolve(known) : rpcPull(code).then(function (r) {
      return (r && r.found) ? { payload: r.payload, updated_at: r.updated_at } : null;
    });

    return step.then(function (remote) {
      var local = buildEnvelope();
      var merged = remote ? mergeEnvelopes(local, remote.payload, MERGE_REGISTRY).merged : local;
      applyEnvelope(merged);

      if (remote && deepEqual(merged, remote.payload)) {
        var m1 = readMeta();
        m1.seenUpdatedAt = remote.updated_at;
        writeMeta(m1);
        clearDirty();
        return true;
      }

      return rpcPush(code, merged, remote ? remote.updated_at : null).then(function (res) {
        if (res && res.ok) {
          var m2 = readMeta();
          m2.seenUpdatedAt = res.updated_at;
          writeMeta(m2);
          clearDirty();
          return true;
        }
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
      setState('idle', '');
    } else {
      setState('error', 'Could not settle with the server. Will retry.');
    }
    return ok;
  }).catch(function (err) {
    if (isOffline()) setState('offline', 'Offline — changes saved on this device.');
    else setState('error', (err && err.status === 404)
      ? 'Sync functions missing on the server — run the migration.'
      : 'Sync error. Will retry.');
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
      return Promise.reject(new Error('This browser cannot read compressed backups. Export again from the other device — it will fall back to the uncompressed format.'));
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
          detail = ' — ' + describeFsrsChange(beforeVal, merged.ns[ns][key].value);
        } else if (key === 'regionsDone') {
          var bn = (local.ns[ns] && local.ns[ns][key] && Array.isArray(local.ns[ns][key].value))
            ? local.ns[ns][key].value.length : 0;
          var an = merged.ns[ns][key].value.length;
          detail = ' — ' + an + ' regions total (' + Math.max(0, an - bn) + ' new)';
        }
        lines.push(ns + ' / ' + key + ': ' + diff.namespaces[ns][key] + detail);
      }
    }
    return {
      ok: true,
      totalChanged: diff.totalChanged,
      summary: lines.length ? lines : ['Nothing new — this device is already up to date.'],
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

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !SCRIPT_URL) return;
  var swUrl;
  try {
    var u = new URL(SCRIPT_URL);
    if (u.origin !== location.origin) return;
    swUrl = new URL('../sw.js', SCRIPT_URL).href;   // assets/../sw.js == hub root
  } catch (e) { return; }
  try { navigator.serviceWorker.register(swUrl).catch(function () {}); } catch (e) {}
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

    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') syncNow('visible');
        else finalFlush();
      });
      window.addEventListener('online', function () { syncNow('online'); });
      window.addEventListener('offline', function () {
        setState('offline', 'Offline — changes saved on this device.');
      });
      window.addEventListener('pagehide', finalFlush);
    } catch (e) {}

    if (isOffline()) setState('offline', 'Offline — changes saved on this device.');
    syncNow('load');
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

  pair: function (input) {
    var code = normalizeCode(input);   // throws with a readable message on bad input
    var meta = readMeta();
    meta.pairCode = code;
    meta.seenUpdatedAt = null;
    writeMeta(meta);
    markDirty();
    return syncNow('pair').then(function () { return formatCode(code); });
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

  exportCode: exportCode,
  previewImport: previewImport,
  importCode: function (str) {
    return previewImport(str).then(function (p) { p.commit(); return p; });
  },

  syncNow: syncNow,

  _debug: {
    setOffline: function (v) {
      FORCE_OFFLINE = !!v;
      if (FORCE_OFFLINE) setState('offline', 'Offline — changes saved on this device.');
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
