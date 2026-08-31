/* StudyAuth — server-checked access, per browser.
 *
 * The code is verified by Supabase (bcrypt, rate limited); this file never sees a hash
 * and cannot be tricked into saying yes. A successful login stores a random token issued
 * by the server. That token is what makes this browser, and only this browser, unlocked.
 *
 * What actually protects a material is that the published file is AES-256-GCM ciphertext.
 * Hiding a row from the list is a convenience; withholding its key is the real control.
 */
(function () {
'use strict';

var SUPABASE_URL      = 'https://gyfqhkhgosjpyvatffbi.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb';

var TOKEN_KEY = 'studyhub:auth:token';
var ROLE_KEY  = 'studyhub:auth:role';
var KEY_CACHE = 'studyhub:auth:keys';     // material id -> base64 key, so unlocked work stays offline
var MAGIC     = [0x53, 0x48, 0x45, 0x31]; // "SHE1"

function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

function rpc(fn, body) {
  return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (r.ok) return r.json();
    /* A raised exception comes back as 400 with the message in the body, not as a status
       code, so the reason has to be read out of the payload. */
    return r.text().then(function (t) {
      if (/rate_limited/.test(t) || r.status === 429) throw new Error('rate_limited');
      throw new Error('http_' + r.status);
    });
  });
}

function readKeys() {
  try { return JSON.parse(ls(KEY_CACHE) || '{}'); } catch (e) { return {}; }
}
function cacheKey(id, key) {
  var all = readKeys();
  all[id] = key;
  lsSet(KEY_CACHE, JSON.stringify(all));
}

var StudyAuth = {
  token: function () { return ls(TOKEN_KEY); },
  role: function () { return ls(ROLE_KEY); },
  isAdmin: function () { return ls(ROLE_KEY) === 'admin'; },
  /* Signed in as far as this device knows. Deliberately optimistic so an unlocked phone
     keeps working on a train; the server is still the authority whenever it is reachable,
     and it is the only source of decryption keys for anything not yet opened. */
  signedIn: function () { return !!ls(TOKEN_KEY); },

  /* Dashes and capitals are for reading the code, not for typing it. Both ends agree on
     the stripped, upper-cased form, so "1n9p fevg43m4f3eq" and "1N9P-FEVG-43M4-F3EQ" are
     the same code. Nothing is lost: the alphabet is uppercase and digits only. */
  normalize: function (code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  },

  login: function (code) {
    return rpc('auth_login', { p_code: StudyAuth.normalize(code) }).then(function (r) {
      if (!r || !r.ok) {
        var e = new Error('bad_code');
        e.friendly = 'That code was not recognised.';
        throw e;
      }
      lsSet(TOKEN_KEY, r.token);
      lsSet(ROLE_KEY, r.role);
      return r.role;
    }, function (err) {
      var e = new Error(err.message);
      e.friendly = err.message === 'rate_limited'
        ? 'Too many tries from this network. Wait about fifteen minutes.'
        : 'Could not reach the server to check that code.';
      throw e;
    });
  },

  /* Confirms the stored token with the server. Offline, the stored session is kept —
     it is not evidence of anything, but signing someone out mid-flight helps nobody. */
  verify: function () {
    var t = ls(TOKEN_KEY);
    if (!t) return Promise.resolve(null);
    return rpc('auth_session', { p_token: t }).then(function (r) {
      if (r && r.ok) { lsSet(ROLE_KEY, r.role); return r.role; }
      StudyAuth.signOut();
      return null;
    }, function () { return ls(ROLE_KEY); });
  },

  signOut: function () {
    var t = ls(TOKEN_KEY);
    lsDel(TOKEN_KEY); lsDel(ROLE_KEY); lsDel(KEY_CACHE);
    if (t) { try { rpc('auth_logout', { p_token: t }).catch(function () {}); } catch (e) {} }
  },

  /* No token needed: the server returns everything that is not hidden. An owner session
     just widens what comes back. */
  catalog: function () {
    return rpc('auth_catalog', { p_token: ls(TOKEN_KEY) }).then(function (r) {
      if (!r || !r.ok) throw new Error('catalog_failed');
      if (r.role) lsSet(ROLE_KEY, r.role); else lsDel(ROLE_KEY);
      lsSet('studyhub:auth:catalog', JSON.stringify(r.items));   // so the hub lists offline
      return r.items;
    }, function (err) {
      var cached = ls('studyhub:auth:catalog');
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      throw err;
    });
  },

  materialKey: function (id) {
    var cached = readKeys()[id];
    if (cached) return Promise.resolve(cached);
    return rpc('auth_material_key', { p_token: ls(TOKEN_KEY), p_id: id }).then(function (r) {
      if (!r || !r.ok) {
        var e = new Error(r && r.error || 'denied');
        e.friendly = (r && r.error === 'locked')
          ? 'This one is locked. The owner\'s admin code opens it.'
          : 'Could not get access to this material.';
        throw e;
      }
      cacheKey(id, r.key);
      return r.key;
    });
  },

  /* Fetch a published .enc and turn it back into HTML.
     The ciphertext is put into the cache here rather than left to the service worker: on
     a first visit the worker is often still installing and not yet controlling the page,
     so its fetch handler never sees this request. Caching it directly means a material
     you have opened once is genuinely available offline, whatever the worker was doing at
     the time. Safe to store — without the key it is noise. */
  openMaterial: function (path, id) {
    var fetched = fetch(path).then(function (r) {
      if (!r.ok) throw new Error('missing_file');
      if (window.caches) {
        try {
          var copy = r.clone();
          caches.open('studyhub-materials').then(function (c) {
            c.put(path, copy);
          }).catch(function () {});
        } catch (e) {}
      }
      return r.arrayBuffer();
    }).catch(function (err) {
      // Offline and the worker did not answer: look in the cache ourselves.
      if (!window.caches) throw err;
      return caches.open('studyhub-materials')
        .then(function (c) { return c.match(path); })
        .then(function (hit) {
          if (!hit) throw new Error('missing_file');
          return hit.arrayBuffer();
        });
    });

    return Promise.all([fetched, StudyAuth.materialKey(id)]).then(function (both) {
      return StudyAuth.decrypt(new Uint8Array(both[0]), both[1]);
    });
  },

  decrypt: function (bytes, keyB64) {
    for (var i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) return Promise.reject(new Error('not_encrypted'));
    }
    var raw = Uint8Array.from(atob(keyB64), function (c) { return c.charCodeAt(0); });
    var iv = bytes.subarray(4, 16);
    var body = bytes.subarray(16);          // WebCrypto expects the tag appended, as it is
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
      .then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, body);
      })
      .then(function (buf) { return new TextDecoder().decode(buf); })
      .catch(function () { throw new Error('decrypt_failed'); });
  },

  /* ---- admin ---- */
  admin: {
    setCode: function (role, code) {
      return rpc('admin_set_code', { p_token: ls(TOKEN_KEY), p_role: role, p_new_code: code });
    },
    setItem: function (id, hidden, locked) {
      return rpc('admin_set_item', { p_token: ls(TOKEN_KEY), p_id: id, p_hidden: hidden, p_locked: locked });
    },
    sessions: function () {
      return rpc('admin_sessions', { p_token: ls(TOKEN_KEY) });
    },
    revokeOthers: function () {
      return rpc('admin_revoke_others', { p_token: ls(TOKEN_KEY) });
    }
  }
};

window.StudyAuth = StudyAuth;
})();
