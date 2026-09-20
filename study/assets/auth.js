/* StudyAuth: server-checked access, per browser.
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
  /* A role without a token is a leftover, not a session: nothing can be done with it and
     the hub would only paint controls that every call then refuses. */
  role: function () { return ls(TOKEN_KEY) ? ls(ROLE_KEY) : null; },
  isAdmin: function () { return !!ls(TOKEN_KEY) && ls(ROLE_KEY) === 'admin'; },
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
      /* An access pass (migration 0017) is minted in the pairing alphabet, so the one code both
         opens the AI features and carries this person's progress between their devices. Pairing
         is best effort: a failure here must never cost them the sign in. */
      if (r.pass && window.StudyStore && StudyStore.pair) {
        try { StudyStore.pair(code); } catch (e) {}
      }
      return r.role;
    }, function (err) {
      var e = new Error(err.message);
      e.friendly = err.message === 'rate_limited'
        ? 'Too many tries from this network. Wait about fifteen minutes.'
        : 'Could not reach the server to check that code.';
      throw e;
    });
  },

  /* Confirms the stored token with the server. Offline, the stored session is kept.
     It is not evidence of anything, but signing someone out mid-flight helps nobody. */
  verify: function () {
    var t = ls(TOKEN_KEY);
    if (!t) return Promise.resolve(null);
    return rpc('auth_session', { p_token: t }).then(function (r) {
      if (r && r.ok) { lsSet(ROLE_KEY, r.role); return r.role; }
      StudyAuth.signOut();
      return null;
    }, function () { return ls(ROLE_KEY); });
  },

  /* The stored session as the server sees it: role, and for a code that is live right now its
     label, end and money left. A code that has ended, run dry or been switched off answers with
     the role alone, which is how a page tells it apart from a live one. */
  session: function () {
    var t = ls(TOKEN_KEY);
    if (!t) return Promise.resolve(null);
    return rpc('auth_session', { p_token: t }).then(function (r) { return r && r.ok ? r : null; }, function () { return null; });
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
     the time. Safe to store: without the key it is noise. */
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

  /* Whether AI grading is on for one material, for the material itself to ask. Anonymous
     on purpose: the answer is three facts a visitor may as well know (on or off, open or
     owner only, which model), and nothing else is exposed. A material treats a rejection
     and a slow answer alike, as off, so the feature can never hold up a page. */
  aiStatus: function (material) {
    return rpc('ai_status', { p_material: material });
  },

  /* The same question for any feature by id ('ask', and whatever comes after it). Just as
     thin: on or off, open or owner only, whether this material carries the feature's tag,
     whether that adds up to available, and whether it is still a beta. */
  /* Asks for this caller, not in general: the answer's `may` is true only for the owner, for a
     live pass that carries the feature and still has money, or for a feature set to open. */
  aiStatus2: function (material, feature) {
    return rpc('ai_status2', { p_material: material, p_feature: feature, p_token: ls(TOKEN_KEY) });
  },

  /* ---- admin ---- */
  admin: {
    setCode: function (role, code) {
      return rpc('admin_set_code', { p_token: ls(TOKEN_KEY), p_role: role, p_new_code: code });
    },
    setItem: function (id, hidden, locked) {
      return rpc('admin_set_item', { p_token: ls(TOKEN_KEY), p_id: id, p_hidden: hidden, p_locked: locked });
    },
    /* A flag like retired or ai is a tag, not a column, so it needs no migration. Flipping
       one means writing the whole item back through the publisher's upsert, which wants the
       key; an admin session can fetch that. hidden and locked are not in the upsert's column
       list, so they survive the round trip. */
    setTag: function (m, tag, on) {
      var t = ls(TOKEN_KEY);
      return rpc('auth_material_key', { p_token: t, p_id: m.id }).then(function (r) {
        if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'no key');
        var tags = (m.tags || []).filter(function (x) { return x !== tag; });
        if (on) tags.push(tag);
        return rpc('admin_upsert_item', { p_token: t, p_item: {
          id: m.id, kind: m.kind || 'material', class_id: m.class_id, class_name: m.class_name,
          term: m.term, title: m.title, blurb: m.blurb, path: m.path, tags: tags,
          added: m.added || null, sort: m.sort == null ? 100 : m.sort, enc_key: r.key
        } });
      });
    },
    setRetired: function (m, retired) { return StudyAuth.admin.setTag(m, 'retired', retired); },

    /* AI grading. Every one of these is refused by the server without an admin token, so
       the panel hiding them is a courtesy and not the control. Nothing here carries an API
       key: the key lives only as an Edge Function secret and is never seen by a browser. */
    ai: {
      settings:   function ()     { return rpc('admin_ai_settings',    { p_token: ls(TOKEN_KEY) }); },
      set:        function (o)    { return rpc('admin_ai_set',         { p_token: ls(TOKEN_KEY), p_settings: o }); },
      usage:      function ()     { return rpc('admin_ai_usage',       { p_token: ls(TOKEN_KEY) }); },
      models:     function ()     { return rpc('admin_ai_models',      { p_token: ls(TOKEN_KEY) }); },
      modelsSet:  function (list) { return rpc('admin_ai_models_set',  { p_token: ls(TOKEN_KEY), p_models: list }); },
      /* Every feature with a row in study_ai_features (0011), with today's and this month's
         spend beside each. SAQ grading has no row: its settings are the ones above. */
      features:   function ()     { return rpc('admin_ai_features',    { p_token: ls(TOKEN_KEY) }); },
      /* A patch: id, plus any of enabled, mode, model, daily_cents. The server checks each. */
      featureSet: function (o)    { return rpc('admin_ai_feature_set', { p_token: ls(TOKEN_KEY), p_feature: o }); },
      /* Access passes (0017): one code per person, with its own money, switch and expiry. */
      passes:     function ()     { return rpc('admin_passes',      { p_token: ls(TOKEN_KEY) }); },
      passCreate: function (o)    { return rpc('admin_pass_create',  { p_token: ls(TOKEN_KEY), p_pass: o }); },
      passSet:    function (o)    { return rpc('admin_pass_set',     { p_token: ls(TOKEN_KEY), p_pass: o }); },
      passDelete: function (id)   { return rpc('admin_pass_delete',  { p_token: ls(TOKEN_KEY), p_id: id }); },
      passSpend:  function (id)   { return rpc('admin_pass_spend',   { p_token: ls(TOKEN_KEY), p_id: id }); },
      /* The code itself, one at a time, and only for codes minted since 0023 kept it. */
      passCode:   function (id)   { return rpc('admin_pass_code',    { p_token: ls(TOKEN_KEY), p_id: id }); },
      /* One code's conversations (0024), newest first. */
      passChats:  function (id, before) { return rpc('admin_pass_chats', { p_token: ls(TOKEN_KEY), p_pass_id: id, p_limit: 50, p_before: before || null }); },
      /* Bug reports (0018). Anyone may file one; only the owner reads them. */
      tickets:    function (status, limit, before) {
        return rpc('admin_tickets', { p_token: ls(TOKEN_KEY), p_status: status || null, p_limit: limit || 30, p_before: before || null });
      },
      ticketSet:  function (id, status, note) { return rpc('admin_ticket_set', { p_token: ls(TOKEN_KEY), p_id: id, p_status: status || null, p_note: note == null ? null : note }); },
      ticketDelete: function (id) { return rpc('admin_ticket_delete', { p_token: ls(TOKEN_KEY), p_id: id }); },
      /* Extra budget for today only (0016). feature null is the global daily cap. It expires by
         itself at the next day boundary, so nothing has to be put back. */
      bonus:      function (f, c) { return rpc('admin_ai_bonus', { p_token: ls(TOKEN_KEY), p_feature: f || null, p_cents: c }); },
      /* Saved Ask conversations (0012), newest first. before is the smallest id already in
         hand, or null for the newest page; the server holds limit to 1 to 500. */
      chats:      function (limit, before) {
        return rpc('admin_ai_chats', { p_token: ls(TOKEN_KEY),
          p_limit: limit == null ? null : limit, p_before: before == null ? null : before });
      },
      /* 1 helpful, -1 not, null clears the rating. */
      chatRate:   function (id, rating) {
        return rpc('ai_chat_rate', { p_token: ls(TOKEN_KEY), p_chat_id: id,
          p_rating: rating == null ? null : rating });
      },

      /* Flags (0033): the sentences the page's own checks could not back, newest first, with the
         question and answer they came from. all true lists the reviewed ones as well. The stats
         are counted over the flags themselves: total is every flag ever written, open is the ones
         not yet reviewed, and by_kind counts the open ones only. An earlier draft of the migration
         grouped by kind first and so counted kinds rather than flags; that was fixed before it
         was applied, and this note is here because the wrong version was believed for a while. */
      flags:         function (limit, all) {
        return rpc('admin_ai_flags', { p_token: ls(TOKEN_KEY),
          p_limit: limit == null ? null : limit, p_all: !!all });
      },
      /* Answers ok whether or not a row matched, so this cannot report an id that was already
         gone. Repaint from a fresh list rather than trusting it. */
      flagReviewed:  function (id) { return rpc('admin_flag_reviewed', { p_token: ls(TOKEN_KEY), p_id: id }); },
      /* Material, topic and body are all required; the server refuses a blank topic or body and
         cannot insert without a material, so pass the flag's own material. topic is matched by
         its words longer than three letters, so a topic of only short words never matches
         anything. flag is the flag this came from, or null; giving it marks that flag reviewed in
         the same call. */
      correctionAdd: function (material, topic, body, flag) {
        return rpc('admin_correction_add', { p_token: ls(TOKEN_KEY), p_material: material,
          p_topic: topic, p_body: body, p_flag: flag == null ? null : flag });
      },
      corrections:   function () { return rpc('admin_corrections', { p_token: ls(TOKEN_KEY) }); },
      /* enabled null leaves the switch alone and an empty body leaves the body alone, so one call
         does either. Off is as far as it goes: nothing here deletes a correction. */
      correctionSet: function (id, enabled, body) {
        return rpc('admin_correction_set', { p_token: ls(TOKEN_KEY), p_id: id,
          p_enabled: enabled == null ? null : !!enabled, p_body: body == null ? null : body });
      },

      /* The guards on Ask (0033): Plain mode, the ceiling on one question, the breaker and what
         it has paused. Reading them recomputes the breaker and writes the result, so this is not
         a free call to poll: ask for it when the group opens or the owner says to, never on a
         timer. mean_cents can be null, and with the breaker off the note reads as much. */
      guards:        function () { return rpc('admin_ai_guards', { p_token: ls(TOKEN_KEY) }); },
      /* key is plain or breaker_on, which take flag; ceiling, breaker or hard, which take num in
         cents; or reset, which clears the pause and takes neither. The keys are not the names the
         read returns, so they have to be mapped. */
      guardSet:      function (key, num, flag) {
        return rpc('admin_ai_guard_set', { p_token: ls(TOKEN_KEY), p_key: key,
          p_num: num == null ? null : num, p_flag: flag == null ? null : !!flag });
      }
    },
    sessions: function () {
      return rpc('admin_sessions', { p_token: ls(TOKEN_KEY) });
    },
    revokeOthers: function () {
      return rpc('admin_revoke_others', { p_token: ls(TOKEN_KEY) });
    },
    /* One time sign ins (a script run, a single visit) and anything unseen for 30 days (0031).
       Never the caller, never a code holder. */
    revokeStale: function () {
      return rpc('admin_revoke_stale', { p_token: ls(TOKEN_KEY) });
    }
  }
};

window.StudyAuth = StudyAuth;
})();
