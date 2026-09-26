/* Study Hub: gate, catalog, sync panel, admin controls. */
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var items = [];
var role = null;

/* ============================================================ owner sign-in */

/* Studying needs no code. Signing in is only for the person who owns the site: it reveals
   the admin controls and the key to anything they have locked. */

function paintOwner() {
  var admin = StudyAuth.isAdmin();
  var chip = $('rolechip');
  chip.textContent = 'Owner';
  chip.hidden = !admin;
  $('adminpanel').hidden = !admin;
  $('ownerform').hidden = admin;
  $('ownerout').hidden = !admin;
  $('ownersum').textContent = admin ? 'Signed in' : 'Signed out';
  var rowState = $('ownerrowstate');
  if (rowState) rowState.textContent = admin ? 'Signed in' : 'Sign in to manage materials';
  var rule = $('ownerrule');
  if (rule) rule.textContent = admin ? 'Only you see these' : 'Only the owner';
  if (!admin && /^owner\//.test(currentScreen())) go('settings/owner');
  $('ownerdot').className = 'dot' + (admin ? ' ok' : ' off');
  $('ownernote').textContent = admin
    ? 'Signed in on this browser. Locked and hidden materials open for you here.'
    : 'Sign in with the admin code to hide, lock or retire materials, change codes, or open anything you have locked. Studying needs no code at all.';
  if (admin) {
    $('whonote').textContent = 'This browser is signed in as the owner. Signing out also clears any keys cached for locked materials.';
  } else {
    aiTeardown();
  }
  role = StudyAuth.role();
}

function initOwner() {
  var peek = $('peek');
  if (peek) peek.addEventListener('click', function () {
    var f = $('ocode');
    var hidden = f.type === 'password';
    f.type = hidden ? 'text' : 'password';
    peek.textContent = hidden ? 'Hide' : 'Show';
    f.focus();
  });

  $('ownerform').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('ownerbtn'), msg = $('ownermsg');
    msg.hidden = true;
    var code = $('ocode').value;
    if (!code.trim()) { msg.textContent = 'Enter the admin code.'; msg.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Checking…';
    StudyAuth.login(code).then(function (r) {
      btn.disabled = false; btn.textContent = 'Sign in';
      $('ocode').value = '';
      if (r !== 'admin') {
        msg.textContent = 'That code works, but it is not the admin code.';
        msg.hidden = false;
      }
      paintOwner();
      loadCatalog().then(function () {
        renderAll($('filter').value.trim().toLowerCase());
        renderRecents();
        initAdmin();
      });
    }, function (err) {
      btn.disabled = false; btn.textContent = 'Sign in';
      msg.textContent = err.friendly || 'That code was not recognised.';
      msg.hidden = false;
      $('ocode').select();
    });
  });

  $('signout').addEventListener('click', function () {
    StudyAuth.signOut();
    location.reload();
  });
}

/* ============================================================ catalog */

function loadCatalog() {
  return StudyAuth.catalog().then(function (list) {
    items = (list || []).filter(function (i) { return i.kind !== 'link'; });
    return items;
  });
}

function showError(title, detail) {
  var box = $('err');
  box.innerHTML = '';
  var h = document.createElement('h2'); h.textContent = title;
  box.appendChild(h);
  if (detail) { var p = document.createElement('p'); p.textContent = detail; box.appendChild(p); }
  box.hidden = false;
}

/* Materials are grouped into their classes for display. The catalog is a flat list so the
   server can filter it per role without knowing anything about how the hub lays it out. */
function groupByClass(list) {
  var order = [], byId = {};
  list.forEach(function (m) {
    var id = m.class_id || 'other';
    if (!byId[id]) {
      byId[id] = { id: id, name: m.class_name || 'Other', term: m.term, materials: [] };
      order.push(byId[id]);
    }
    byId[id].materials.push(m);
  });
  return order;
}

function matches(m, klass, needle) {
  if (!needle) return true;
  var hay = [m.title, m.blurb, (m.tags || []).join(' '), klass.name, klass.id].join(' ').toLowerCase();
  return needle.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
}

var hasTag = function (m, tag) { return (m.tags || []).indexOf(tag) !== -1; };
var isRetired = function (m) { return hasTag(m, 'retired'); };
var withTag = function (m, tag, on) {
  return (m.tags || []).filter(function (x) { return x !== tag; }).concat(on ? [tag] : []);
};

function makeRow(m) {
  var lockedForMe = m.locked && role !== 'admin';
  var a = document.createElement('button');
  a.type = 'button';
  a.className = 'mat' + (lockedForMe ? ' locked' : '') + (isRetired(m) ? ' retired' : '');

  var title = document.createElement('span');
  title.className = 't';
  title.textContent = m.title;
  a.appendChild(title);
  if (m.blurb) {
    var b = document.createElement('span');
    b.className = 'd'; b.textContent = m.blurb;
    a.appendChild(b);
  }
  var meta = document.createElement('span');
  meta.className = 'm';
  if (m.locked) meta.appendChild(flag('warn', 'Locked'));
  if (m.hidden) meta.appendChild(flag('', 'Hidden'));
  if (isRetired(m)) meta.appendChild(flag('', 'Retired'));
  /* The owner's reminder of which materials offer Ask or grading. Nothing of it is drawn
     for anyone else, and the word AI never appears on screen (export README). */
  if (StudyAuth.isAdmin() && aiHasAnyTag(m)) meta.appendChild(flag('ask', 'Ask'));
  if (m.added) {
    var ad = document.createElement('span');
    ad.className = 'dt'; ad.textContent = niceDate(m.added);
    meta.appendChild(ad);
  }
  if (meta.children.length) a.appendChild(meta);
  a.addEventListener('click', function () { open(m); });
  return a;
}

/* "2026-09-25" as "25 Sep", the way the export writes dates. */
function niceDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return Number(m[3]) + ' ' + mon;
}

function renderAll(needle) {
  var wrap = $('classes');
  wrap.innerHTML = '';
  var shown = 0;
  var retired = [];

  groupByClass(items).forEach(function (klass) {
    var mats = klass.materials.filter(function (m) { return matches(m, klass, needle); });
    if (!mats.length) return;

    var sec = document.createElement('section');
    sec.className = 'klass';
    sec.id = klass.id;
    sec.setAttribute('data-subject', klass.id);

    var head = document.createElement('div');
    head.className = 'cls';
    var sw = document.createElement('span');
    sw.className = 'swatch';
    head.appendChild(sw);
    var h2 = document.createElement('h2');
    h2.textContent = klass.name;
    head.appendChild(h2);
    var t = document.createElement('span');
    t.className = 'meta';
    head.appendChild(t);
    sec.appendChild(head);

    var ul = document.createElement('div');
    ul.className = 'group';

    mats.forEach(function (m) {
      if (isRetired(m)) { retired.push(m); shown++; return; }
      ul.appendChild(makeRow(m));
      shown++;
    });

    t.textContent = String(ul.children.length);
    if (ul.children.length) { sec.appendChild(ul); wrap.appendChild(sec); }
  });

  /* Retired things stay openable (an old quiz's material is still a good review) but sit
     under one collapsed heading at the bottom, out of the way of what is current. */
  if (retired.length) {
    var det = document.createElement('details');
    det.className = 'retiredwrap group';
    det.open = !!needle;
    var sum = document.createElement('summary');
    sum.className = 'lrow';
    sum.innerHTML = '<span class="ico neutral"><svg><use href="#i-box"/></svg></span><span class="main"><span>Retired</span><span class="desc"></span></span><svg class="chev"><use href="#i-chev"/></svg>';
    sum.querySelector('.desc').textContent = retired.length + ' from earlier quizzes and assignments';
    det.appendChild(sum);
    var rul = document.createElement('div');
    rul.className = 'retiredrows';
    retired.forEach(function (m) { rul.appendChild(makeRow(m)); });
    det.appendChild(rul);
    wrap.appendChild(det);
  }

  $('noresults').hidden = shown > 0;
  var n = items.length;
  var classes = groupByClass(items).length;
  var now = new Date();
  var day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()] + ' ' + now.getDate() + ' ' +
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()] + '. ';
  $('subline').textContent = day + (n
    ? n + ' material' + (n === 1 ? '' : 's') + (classes > 1 ? ' in ' + classes + ' classes' : '') + '.'
    : 'No materials yet.');
}

function flag(cls, text) {
  var s = document.createElement('span');
  s.className = 'tg' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function open(m) {
  if (m.locked && !StudyAuth.isAdmin()) {
    go('settings/owner');
    $('ownermsg').textContent = '"' + m.title + '" is locked. Sign in as the owner to open it.';
    $('ownermsg').hidden = false;
    return;
  }
  recordRecent(m);
  location.href = 'view.html?m=' + encodeURIComponent(m.id);
}

/* ============================================================ recents */

function recordRecent(m) {
  if (!window.StudyStore) return;
  StudyStore.get('recent').then(function (list) {
    list = Array.isArray(list) ? list : [];
    list = list.filter(function (r) { return r && r.id !== m.id; });
    list.unshift({ id: m.id, title: m.title, ts: Date.now() });
    StudyStore.set('recent', list.slice(0, 8));
  });
}

function renderRecents() {
  if (!window.StudyStore) return;
  StudyStore.get('recent').then(function (list) {
    if (!Array.isArray(list) || !list.length) return;
    var known = {};
    items.forEach(function (i) { known[i.id] = i; });
    var box = $('recent');
    box.innerHTML = '';
    list.forEach(function (r) {
      if (!r || !known[r.id]) return;         // drop anything hidden from this role
      var m = known[r.id];
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'rc';
      b.innerHTML = '<span class="t"></span><span class="c"><span class="swatch"></span><span></span></span>';
      b.querySelector('.t').textContent = r.title || r.id;
      b.querySelector('.c').setAttribute('data-subject', m.class_id || 'other');
      b.querySelector('.c span:last-child').textContent = m.class_name || '';
      b.addEventListener('click', function () { open(known[r.id]); });
      box.appendChild(b);
    });
    $('recentwrap').hidden = !box.children.length;
  });
}

/* ============================================================ hash route */

/* Screens: home, settings (settings/owner scrolls to the owner part) and the owner's four
   sub screens. One document, one scroll per screen; the home keeps its place when you come
   back to it. The export: Hub, HubSettings, OwnerHome390. */
var SCREENS = { '': 'scr-home', 'settings': 'scr-settings', 'owner/materials': 'scr-owner-materials',
                'owner/access': 'scr-owner-access', 'owner/inbox': 'scr-owner-inbox', 'owner/ask': 'scr-owner-ask' };
var homeScroll = 0, shownScreen = '';
function currentScreen() { return shownScreen; }
function go(route) { if (('#' + route) !== location.hash) location.hash = route; else showRoute(route); }
function showRoute(route) {
  var anchor = null;
  if (route === 'settings/owner' || route === 'owner') { anchor = 'ownerpanel'; route = 'settings'; }
  if (route === 'settings/sync') { anchor = 'syncpanel'; route = 'settings'; }
  if (/^owner\//.test(route) && !(window.StudyAuth && StudyAuth.isAdmin())) { anchor = 'ownerpanel'; route = 'settings'; }
  if (!SCREENS.hasOwnProperty(route)) route = '';
  if (shownScreen === '' && route !== '') homeScroll = window.scrollY;
  Object.keys(SCREENS).forEach(function (k) { var e = $(SCREENS[k]); if (e) e.hidden = k !== route; });
  var was = shownScreen;
  shownScreen = route;
  if (anchor) { var a = $(anchor); if (a) a.scrollIntoView({ block: 'start' }); }
  else if (route === '' && was !== '') window.scrollTo(0, homeScroll);
  else if (route !== was) window.scrollTo(0, 0);
  if (route === 'owner/ask' && typeof initAi === 'function') initAi();
}

function handleHash() {
  var h = (location.hash || '').replace(/^#/, '');
  if (!h || SCREENS.hasOwnProperty(h) || h === 'settings/owner' || h === 'owner' || h === 'settings/sync') { showRoute(h); return; }

  if (h.indexOf('pair=') === 0) {
    var code = decodeURIComponent(h.slice(5));
    showRoute('settings');
    $('paircode').value = code;
    $('pairblock').scrollIntoView({ block: 'start' });
    if (window.confirm('Pair this device with code ' + code + '?')) doPair();
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  var el = document.getElementById(h);
  if (el) {
    var scr = el.closest ? el.closest('[data-screen]') : null;
    if (scr) showRoute(scr.getAttribute('data-screen') === 'home' ? '' : scr.getAttribute('data-screen'));
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1600);
  }
}

/* ============================================================ sync panel */

function relTime(ms) {
  if (!ms) return 'never';
  var s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  var m = Math.round(s / 60);
  if (m < 60) return m + ' minutes ago';
  var h = Math.round(m / 60);
  if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  var d = Math.round(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}

/* A sync is three steps, not a stream, so there is no fraction of it to measure and the
   step number is what gets reported. The review queue is the one genuinely countable thing
   here: a known number of events going up 200 at a time. */
function paintProgress(st) {
  var wrap = $('syncbar');
  if (!wrap) return;
  var pct = null, text = '';

  if (st.progress) {
    pct = Math.round(st.progress.index / st.progress.of * 100);
    text = 'Step ' + st.progress.index + ' of ' + st.progress.of + ' · ' + st.progress.label;
    if (st.progress.attempt > 1) {
      text += ' · try ' + st.progress.attempt + ' of ' + st.progress.attempts;
    }
  } else if (st.telemetry && st.telemetry.total) {
    pct = Math.round(st.telemetry.sent / st.telemetry.total * 100);
    text = 'Sending review logs · ' + st.telemetry.sent + ' of ' + st.telemetry.total;
  }

  if (pct === null) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('syncbarfill').style.width = pct + '%';
  $('syncbarlabel').textContent = text;
  wrap.setAttribute('aria-valuenow', String(pct));
  wrap.setAttribute('aria-valuetext', text);
}

/* The one line in the header, always on.
 *
 * Everything it says was already known to the page, but it lived inside a panel that is
 * shut by default, so the answer to "did my work actually go up, and when" was three taps
 * away. This is the same state as a sentence, and it stays legible while a sync runs
 * because the step bar is mirrored into it. */
function paintStrip(st) {
  var strip = $('syncstrip');
  if (!strip) return;
  var dot = $('stripdot'), bar = $('stripbar');
  var msg;

  dot.className = 'dot';
  if (!st.configured) {
    dot.classList.add('off'); msg = 'Saved on this device';
  } else if (!st.paired) {
    dot.classList.add('off'); msg = 'Saved here · not paired';
  } else if (st.state === 'syncing') {
    dot.classList.add('busy');
    msg = st.progress
      ? 'Syncing · step ' + st.progress.index + ' of ' + st.progress.of
      : 'Syncing';
  } else if (st.state === 'offline') {
    dot.classList.add('off'); msg = 'No connection · saved here';
  } else if (st.state === 'error') {
    dot.classList.add('bad'); msg = 'Sync problem · will retry';
  } else {
    dot.classList.add('ok');
    msg = st.lastSyncedAt ? 'Synced ' + relTime(st.lastSyncedAt) : 'Paired · not synced yet';
    if (st.dirty) msg += ' · changes pending';
  }
  $('striptext').textContent = msg;

  /* The same measurements the panel shows: sync steps first, then the review queue, which
     is the one genuinely countable thing here. */
  var pct = null;
  if (st.progress) pct = Math.round(st.progress.index / st.progress.of * 100);
  else if (st.telemetry && st.telemetry.total) {
    pct = Math.round(st.telemetry.sent / st.telemetry.total * 100);
  }
  if (pct === null) { bar.hidden = true; return; }
  bar.hidden = false;
  $('stripbarfill').style.width = pct + '%';
}

/* How much this device holds and would send, so "did it save" has an answer. Size is shown
   against the server's cap because a row over it is refused whole. */
var lastSizePaint = 0;
function paintSyncSize() {
  var el = $('syncsize');
  if (!el || !window.StudyStore || !StudyStore.syncSummary) return;
  if (Date.now() - lastSizePaint < 5000) return;
  lastSizePaint = Date.now();
  var sum = StudyStore.syncSummary();
  var names = Object.keys(sum.namespaces).filter(function (ns) { return sum.namespaces[ns].synced.length; });
  var kb = Math.round(sum.bytes / 1024);
  el.textContent = names.length
    ? 'This device holds ' + names.length + ' material' + (names.length === 1 ? '' : 's') + ' of progress, ' + kb +
      ' KB of the ' + Math.round(sum.limit / 1024) + ' KB a sync can carry.' + (sum.bytes > sum.limit * 0.8 ? ' That is close to the limit.' : '')
    : 'Nothing saved on this device yet.';
}

function paintStatus(st) {
  paintSyncSize();
  var dot = $('syncdot'), line = $('statusline'), sum = $('syncsum');
  paintProgress(st);
  paintStrip(st);
  dot.className = 'dot';
  if (!st.configured) {
    dot.classList.add('off'); sum.textContent = 'local only';
    line.textContent = 'Sync is not configured. Everything still saves on this device, and the backup below needs no server.';
  } else if (!st.paired) {
    dot.classList.add('off'); sum.textContent = 'not paired';
    line.textContent = 'Saved on this device. Pair with a code to keep your other devices in step.';
  } else if (st.state === 'syncing') {
    dot.classList.add('busy'); sum.textContent = 'syncing'; line.textContent = 'Syncing…';
  } else if (st.state === 'offline') {
    dot.classList.add('off'); sum.textContent = 'offline';
    line.textContent = 'Offline: changes are saved here and will sync when you are back online.';
  } else if (st.state === 'error') {
    dot.classList.add('bad'); sum.textContent = 'retrying';
    line.textContent = st.message || 'Sync hit a problem. It will try again.';
  } else {
    dot.classList.add('ok'); sum.textContent = 'synced';
    line.textContent = 'Synced ' + relTime(st.lastSyncedAt) + (st.dirty ? ' · changes pending' : '') + '.';
  }
  $('unpaired').hidden = st.paired;
  $('paired').hidden = !st.paired;
  if (st.paired && st.codeDisplay) {
    $('maskedcode').textContent = st.codeDisplay.slice(0, 4) + '-••••-••••';
    $('maskedcode').dataset.code = st.codeDisplay;
  }
  $('pairnote').textContent = st.configured
    ? 'One code links your devices. It is separate from your access code.'
    : 'Not configured.';
}

function doPair() {
  var errEl = $('pairerr');
  errEl.hidden = true;
  var typed = $('paircode').value;
  try {
    StudyStore.pair(typed).then(function (r) {
      $('paircode').value = '';
      /* An AI code (0017) is a save code and a sign in at once, and people put it in whichever
         box they see first. Pairing alone synced their progress and left the AI off, with
         nothing to say why: on 2026-09-17 a friend's code went in here and Ask never appeared.
         So a pairing also tries the code as a sign in, unless this device is already signed
         in. The try goes through auth_login, which is rate limited per address, so it cannot be
         used to guess codes; a plain save code that is not an AI code costs one failed attempt,
         and a device pairs rarely enough that the limit is never near. */
      var signedIn = !!(window.StudyAuth && StudyAuth.token && StudyAuth.token());
      /* Signed in is not the same as live: a code whose time is up still signs in, so that it
         wakes up by itself if the owner extends or revives it, but until then its holder is told
         what any visitor pairing a save code is told, and sees no AI at all. */
      var asCode = (!signedIn && window.StudyAuth && StudyAuth.login)
        ? StudyAuth.login(typed).then(function (role) {
            if (!role || !StudyAuth.session) return null;
            return StudyAuth.session().then(function (s) { return s && s.pass ? role : null; });
          }, function () { return null; })
        : Promise.resolve(null);
      return asCode.then(function (role) {
        if (role) {
          window.alert('Paired with ' + r.code + ', and signed in with it. ' +
            'The Ask features this code carries are on: highlight text in a material and tap Ask, or press Alt and A.');
          try { renderAll(); } catch (e) {}
          return;
        }
        if (r.found === false) {
          /* A mistyped code does not fail: it quietly starts a new, empty sync group that the
             other device is not in. The absence of any stored progress is the only tell. */
          window.alert('Paired with ' + r.code + ', but nothing is stored under that code yet. ' +
            'If your other device already has progress, check the code against it and pair again. ' +
            'Otherwise this device\'s progress will be the first to go up.');
        } else {
          window.alert('Paired. Your progress will merge with code ' + r.code + '.');
        }
      });
    });
  } catch (e) {
    errEl.textContent = e.message; errEl.hidden = false;
  }
}

function initSyncPanel() {
  /* Wired before the guard below: the header line has to open the panel even on a device
     where sync.js failed to load, or tapping it would do nothing at all. */
  var strip = $('syncstrip');
  if (strip) strip.addEventListener('click', function () { go('settings/sync'); });

  if (!window.StudyStore) {
    $('statusline').textContent = 'The sync module did not load. Materials still save on this device.';
    $('syncsum').textContent = 'unavailable';
    $('striptext').textContent = 'Saved on this device';
    return;
  }
  StudyStore.on('status', paintStatus);
  /* "Synced 2 minutes ago" has to keep being true while you sit there, so the line is
     repainted on a timer as well as on every state change. */
  setInterval(function () { paintStatus(StudyStore.status()); }, 20000);
  /* And immediately on coming back to the app, so a phone picked up after an hour is not
     showing the sentence it went to sleep with. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') paintStatus(StudyStore.status());
  });

  $('makecode').addEventListener('click', function () {
    var code = StudyStore.createPairCode();
    $('bigcode').textContent = code;
    $('codeout').hidden = false;
    $('unpaired').hidden = true;
    renderQR(location.href.split('#')[0] + '#pair=' + encodeURIComponent(code), $('qr'));
  });
  $('codedone').addEventListener('click', function () {
    $('codeout').hidden = true; paintStatus(StudyStore.status());
  });
  $('dopair').addEventListener('click', doPair);
  $('paircode').addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair(); });

  $('reveal').addEventListener('click', function () {
    var full = $('maskedcode').dataset.code || '';
    var showing = $('maskedcode').textContent === full;
    $('maskedcode').textContent = showing ? full.slice(0, 4) + '-••••-••••' : full;
    this.textContent = showing ? 'Show code' : 'Hide code';
  });
  $('showqr').addEventListener('click', function () {
    var wrap = $('pairedqrwrap');
    if (!wrap.hidden) { wrap.hidden = true; this.textContent = 'Show square'; return; }
    renderQR(location.href.split('#')[0] + '#pair=' + encodeURIComponent($('maskedcode').dataset.code || ''), $('pairedqr'));
    wrap.hidden = false; this.textContent = 'Hide square';
  });
  $('syncnow').addEventListener('click', function () { StudyStore.syncNow('manual'); });
  $('unpair').addEventListener('click', function () {
    if (!window.confirm('Unpair this device? Your progress stays here; it just stops syncing.')) return;
    StudyStore.unpair();
    $('pairedqrwrap').hidden = true;
    paintStatus(StudyStore.status());
  });

  $('doexport').addEventListener('click', function () {
    StudyStore.exportCode().then(function (code) {
      var box = $('iobox');
      box.value = code; box.hidden = false; box.readOnly = true;
      $('iorow').hidden = false; $('copyout').hidden = false;
      $('preview').hidden = true; $('importpreview').hidden = true;
      box.focus(); box.select();
    });
  });
  $('copyout').addEventListener('click', function () {
    var box = $('iobox'), self = this;
    var done = function () { self.textContent = 'Copied'; setTimeout(function () { self.textContent = 'Copy'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(done, function () { box.select(); document.execCommand('copy'); done(); });
    } else { box.select(); document.execCommand('copy'); done(); }
  });
  $('doimport').addEventListener('click', function () {
    var box = $('iobox');
    box.value = ''; box.hidden = false; box.readOnly = false;
    $('iorow').hidden = false; $('copyout').hidden = true;
    $('preview').hidden = false; $('importpreview').hidden = true;
    box.focus();
  });
  $('preview').addEventListener('click', function () {
    var out = $('importpreview');
    out.hidden = false; out.textContent = 'Reading…';
    StudyStore.previewImport($('iobox').value).then(function (p) {
      out.innerHTML = '';
      var h = document.createElement('h4');
      h.textContent = p.totalChanged ? 'This import would change:' : 'Nothing to change';
      out.appendChild(h);
      var ul = document.createElement('ul');
      p.summary.forEach(function (line) {
        var li = document.createElement('li'); li.textContent = line; ul.appendChild(li);
      });
      out.appendChild(ul);
      if (p.totalChanged) {
        var row = document.createElement('div'); row.className = 'row wrap';
        var apply = document.createElement('button');
        apply.className = 'btn'; apply.type = 'button'; apply.textContent = 'Apply';
        apply.addEventListener('click', function () {
          p.commit();
          out.innerHTML = '<h4>Imported</h4><p>Merged into this device.</p>';
          renderRecents();
        });
        var cancel = document.createElement('button');
        cancel.className = 'btn ghost'; cancel.type = 'button'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', function () { p.discard(); out.hidden = true; });
        row.appendChild(apply); row.appendChild(cancel);
        out.appendChild(row);
      }
    }).catch(function (e) {
      out.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'err-inline';
      p.textContent = e.message || 'That backup code could not be read.';
      out.appendChild(p);
    });
  });

}

/* ============================================================ admin */

function renderAdminItems() {
  var box = $('adminitems');
  /* Retired materials go under one collapsed heading at the foot of this list, the way the hub
     list files them, so a pile of old hidden ones does not crowd out what is current. Whether
     it was open survives a redraw, so switching one of them does not snap it shut. */
  var wasOpen = !!(box.querySelector('.retiredwrap') && box.querySelector('.retiredwrap').open);
  aiPopOpen = null;
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = '<p class="note">Nothing published yet.</p>'; return; }
  var retiredRows = [];

  items.forEach(function (m, i) {
    var row = document.createElement('div');
    row.className = 'adminrow';

    var name = document.createElement('div');
    name.className = 'an';
    name.innerHTML = '<span></span><small></small>';
    name.firstChild.textContent = m.title;
    name.lastChild.textContent = m.id;

    var togs = document.createElement('div');
    togs.className = 'toggles';

    function mk(label, on, apply) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'tog';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(!!on));
      b.addEventListener('click', function () {
        var next = b.getAttribute('aria-pressed') !== 'true';
        b.disabled = true;
        apply(next).then(function (r) {
          b.disabled = false;
          if (r && r.ok) {
            b.setAttribute('aria-pressed', String(next));
            loadCatalog().then(function () {
              renderAll($('filter').value.trim().toLowerCase());
              /* Retiring or un-retiring moves the row between the two lists. */
              if (label === 'Retired') renderAdminItems();
            });
          }
        }, function () { b.disabled = false; });
      });
      return b;
    }

    togs.appendChild(mk('Hidden', m.hidden, function (v) {
      m.hidden = v; return StudyAuth.admin.setItem(m.id, v, null);
    }));
    togs.appendChild(mk('Locked', m.locked, function (v) {
      m.locked = v; return StudyAuth.admin.setItem(m.id, null, v);
    }));
    togs.appendChild(mk('Retired', isRetired(m), function (v) {
      return StudyAuth.admin.setTag(m, 'retired', v).then(function (r) {
        if (r && r.ok) m.tags = withTag(m, 'retired', v);
        return r;
      });
    }));
    /* Each AI feature is offered by a material only when it carries that feature's tag. The
       tags are the narrow gate: every switch in the AI section below can be on and this
       material still offers nothing it is not tagged for. One control holds all of them, so
       a new feature is a line in AI_FEATURES rather than another button on every row. */
    if (StudyAuth.isAdmin()) togs.appendChild(aiTagControl(m, i));

    row.appendChild(name); row.appendChild(togs);
    if (isRetired(m)) retiredRows.push(row); else box.appendChild(row);
  });

  if (retiredRows.length) {
    var det = document.createElement('details');
    det.className = 'retiredwrap adminretired';
    det.open = wasOpen;
    var sum = document.createElement('summary');
    sum.innerHTML = '<span class="kname">Retired</span><span class="kterm"></span>';
    sum.lastChild.textContent = retiredRows.length + (retiredRows.length === 1 ? ' material' : ' materials');
    det.appendChild(sum);
    retiredRows.forEach(function (row) { det.appendChild(row); });
    box.appendChild(det);
  }
}

/* The per material AI control: a small button that says how many features this material
   carries, opening a short list with one checkbox per feature. Only one list is open at a
   time; a tap anywhere else, focus moving elsewhere, or Escape closes it. */
var aiPopOpen = null;
var aiPopWired = false;

function aiPopClose(refocus) {
  var p = aiPopOpen;
  if (!p) return;
  aiPopOpen = null;
  p.menu.hidden = true;
  p.btn.setAttribute('aria-expanded', 'false');
  if (refocus) { try { p.btn.focus(); } catch (e) {} }
}

function aiPopWire() {
  if (aiPopWired) return;
  aiPopWired = true;
  var outside = function (ev) {
    if (aiPopOpen && !aiPopOpen.wrap.contains(ev.target)) aiPopClose(false);
  };
  if (window.PointerEvent) {
    document.addEventListener('pointerdown', outside, true);
  } else {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('touchstart', outside, true);
  }
  document.addEventListener('focusin', outside, true);
  document.addEventListener('keydown', function (ev) {
    if (aiPopOpen && (ev.key === 'Escape' || ev.key === 'Esc')) {
      ev.preventDefault();
      aiPopClose(true);
    }
  });
}

function aiTagControl(m, i) {
  aiPopWire();
  var offered = aiTagFeatures();
  var total = offered.length;
  var wrap = el('div', 'aipop');
  var btn = el('button', 'tog aipopbtn');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  var menu = el('div', 'aipopmenu');
  menu.id = 'aipop-' + i;
  menu.hidden = true;
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Ask features for ' + (m.title || m.id));
  btn.setAttribute('aria-controls', menu.id);

  var err = el('p', 'err-inline aipoperr');
  err.hidden = true;
  var boxes = [];

  function paintBtn() {
    var n = offered.filter(function (f) { return hasTag(m, f.tag); }).length;
    btn.textContent = 'Ask ' + n + '/' + total;
    btn.setAttribute('aria-label', 'Ask features, ' + n + ' of ' + total + ' on');
    btn.classList.toggle('some', n > 0);
  }

  function settle(box, on, text) {
    boxes.forEach(function (b) { b.disabled = false; });
    if (text == null) return;
    box.checked = !on;
    err.textContent = text;
    err.hidden = false;
  }

  offered.forEach(function (f) {
    var lab = el('label', 'aipopitem');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = hasTag(m, f.tag);
    lab.appendChild(box);
    lab.appendChild(el('span', null, f.label));
    menu.appendChild(lab);
    boxes.push(box);

    box.addEventListener('change', function () {
      var on = box.checked;
      err.hidden = true;
      /* setTag writes the whole tag list back. Two writes in flight would each carry the list
         from before the other, and the later one would undo the earlier, so one at a time. */
      boxes.forEach(function (b) { b.disabled = true; });
      StudyAuth.admin.setTag(m, f.tag, on).then(function (r) {
        if (r && r.ok) {
          settle(box, on, null);
          m.tags = withTag(m, f.tag, on);
          paintBtn();
          loadCatalog().then(function () {
            renderAll($('filter').value.trim().toLowerCase());
          }).catch(function () {});
          return;
        }
        settle(box, on, r && r.error === 'forbidden'
          ? 'That admin session was refused. Sign in again.'
          : 'Could not save that.');
      }, function () {
        settle(box, on, 'Could not save that.');
      });
    });
  });
  menu.appendChild(err);

  btn.addEventListener('click', function () {
    if (aiPopOpen && aiPopOpen.btn === btn) { aiPopClose(false); return; }
    aiPopClose(false);
    err.hidden = true;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    aiPopOpen = { wrap: wrap, btn: btn, menu: menu };
  });

  paintBtn();
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

/* ============================================================ AI */

/* Built here rather than written into index.html so the section does not exist in the
   document at all unless this browser holds an admin session. That is convenience, not
   security: every control below writes through a token checked RPC that decides again on
   the server, and the only anonymous surface the features have is ai_status and ai_status2,
   which answer with a few facts and nothing else. No API key is ever in reach of this file;
   the key lives as an Edge Function secret.

   The section is groups that stay closed until opened, so it does not grow a screen
   longer each time a feature is added: Spend (the master switch and the ceilings every
   feature spends against), Features (one row each), Guards (what one Ask answer may cost,
   0033), Codes, Reports, Flags and Corrections (the loop that fixes a wrong answer, 0033),
   Models (what the eval measured), Recent calls (the ledger) and Chats (saved Ask
   conversations, rated and exported). */

/* Every AI feature, one line each. id is the feature's id on the server, tag is what a
   material carries to offer it, label is what the per material control reads. 'saq' has no
   row in study_ai_features: its mode and model live in study_ai_settings (0010). A third
   feature is one line here and one row in study_ai_features.

   The five escalations (0033) are rows in study_ai_features like any other feature, so
   without a line here the Features group, the ledger and the chats would each print a bare
   id. They are marked esc because none of them has a tag of its own: they run inside Ask, on
   Ask's tag, so no material carries one and the per material control leaves them out. All
   five are off on the server until they are turned on. */
var AI_FEATURES = [
  { id: 'saq', tag: 'ai',     label: 'SAQ grading', short: 'SAQ', own: true },
  { id: 'ask', tag: 'ai-ask', label: 'Ask (beta)',  short: 'Ask', own: true },
  { id: 'trap', tag: 'ai-ask', label: 'Trap note', short: 'Trap',
    about: 'A two line note on a card, written once and stored, so it is paid for once.' },
  { id: 'rerank', tag: 'ai-ask', label: 'Reranker', short: 'Rerank', esc: true,
    about: 'Picks better passages when the keyword search is weak.' },
  { id: 'retry', tag: 'ai-ask', label: 'Retry', short: 'Retry', esc: true,
    about: 'One more attempt when a check on the page catches a fault.' },
  { id: 'tools', tag: 'ai-ask', label: 'Tools', short: 'Tools', esc: true,
    about: 'Lets an answer search the material again mid answer.' },
  { id: 'wiki', tag: 'ai-ask', label: 'Wikipedia', short: 'Wiki', esc: true,
    about: 'One Wikipedia lead section, on request.' },
  { id: 'search', tag: 'ai-ask', label: 'Web search', short: 'Search', esc: true,
    about: 'Web search, off and unbuilt.' },
  /* Research mode (migration 0034). Two modes and an intensifier, each its own row so each has its
     own daily cap and the breaker can pause one without the others. fetch is not an escalation:
     pulling a link spends no tokens at all, and the row exists so link pulling can be switched off
     on its own. */
  { id: 'research', tag: 'ai-ask', label: 'Research: class sources', short: 'Research', esc: true,
    about: 'Answers from the documents loaded for that class, cited by name. About 2.5 cents.' },
  { id: 'extern', tag: 'ai-ask', label: 'Research: own links', short: 'Links', esc: true,
    about: 'Answers from pages the owner pasted in, cited by site. About 2.5 cents.' },
  { id: 'deep', tag: 'ai-ask', label: 'Deep research', short: 'Deep', esc: true,
    about: 'A long answer that thinks first, from three times as much of the sources. About 12 cents, and its own ceiling.' },
  { id: 'fetch', tag: 'ai-ask', label: 'Pull a link', short: 'Fetch', esc: false, nomodel: true,
    about: 'Reading a page into the shelf. No model and no tokens: the text is extracted in code.' }
];

/* How the Features tab groups its rows, in the order they are shown. An id the panel has never
   heard of lands in other, so a row added on the server is never invisible here. */
var AI_FEATURE_GROUPS = [
  { id: 'main', title: 'Features', ids: ['saq', 'ask', 'trap'] },
  { id: 'extras', title: 'Extras on an Ask answer', ids: ['rerank', 'retry'],
    sub: 'Each runs only when an answer needs it. Plain mode holds them, and the breaker can pause them.' },
  { id: 'research', title: 'Research', ids: ['research', 'extern', 'deep', 'fetch'],
    sub: 'Answers from sources you chose. Plain mode and the breaker hold these too, except pulling a link, which spends nothing.' },
  { id: 'other', title: 'Other', ids: [] },
  { id: 'unbuilt', title: 'Not built yet', ids: ['tools', 'wiki', 'search'], folded: true,
    sub: 'Rows that exist on the server with nothing behind them. Web search is not allowed at all.' }
];

function aiFeatureInfo(id) {
  var hit = null;
  AI_FEATURES.forEach(function (f) { if (f.id === id) hit = f; });
  return hit;
}

/* The features a material can be tagged for: the ones with a tag of their own. Everything else
   runs inside Ask on Ask's tag. This used to be "not an escalation", which let Pull a link in
   (it is not one, since it spends nothing): every material then offered a third checkbox that
   wrote the same ai-ask tag as the second, and counted itself in "AI 2/3". */
function aiTagFeatures() {
  return AI_FEATURES.filter(function (f) { return f.own; });
}

function aiHasAnyTag(m) {
  return aiTagFeatures().some(function (f) { return hasTag(m, f.tag); });
}

/* Stored units are cents and counts; the two money fields are typed in dollars because
   nobody budgets in cents. min and max mirror the checks in 0010 so a value the server
   will refuse can be named before the round trip, and the server still has the last word. */
var AI_FIELDS = [
  { key: 'daily_cents',       label: 'Daily cap',              money: true, min: 0,   max: 10000 },
  { key: 'monthly_cents',     label: 'Monthly cap',            money: true, min: 0,   max: 10000 },
  { key: 'per_install_daily', label: 'Calls per device, day',               min: 0,   max: 500 },
  { key: 'per_ip_minute',     label: 'Calls per address, min',              min: 1,   max: 60 },
  { key: 'max_chars',         label: 'Max characters',                      min: 200, max: 6000 }
];

/* A feature's own daily cap, in cents, as 0011 checks it. */
var AI_FEATURE_CAP = { min: 0, max: 10000 };

/* One grade is about this many tokens, so a price per million becomes a price per grade
   the owner can actually compare. It is an estimate and the ledger is the truth. */
var AI_IN_TOKENS = 1200, AI_OUT_TOKENS = 250;

/* Which groups are open is a per browser convenience, nothing more. */
var AI_GROUPS_KEY = 'studyhub:admin:aigroups';
var AI_TAB_KEY = 'studyhub:admin:aitab';

/* Chats: twenty to a page on screen; an export asks for the server's largest page and stops
   after twenty of them, ten thousand chats, rather than looping on a server that misbehaves. */
var AI_CHATS_PAGE = 20;
var AI_CHATS_EXPORT_PAGE = 500;
var AI_CHATS_EXPORT_PAGES = 20;

/* Flags (0033) have no cursor, only a limit the server holds to 200, so there is no Show more
   to offer: the list says how many of the newest to ask for and asks again. */
var AI_FLAG_LIMITS = [20, 50, 100, 200];

/* Every guard is stored in cents, not dollars like the caps, and the server holds each one to
   a range: 100, except the deep ceiling, which 0034 holds to 200. */
var AI_GUARD_MAX_CENTS = 100;
var AI_GUARD_MAX = { deep_ceiling: 200 };

var aiEl = null;
var aiState = { settings: null, models: [], usage: null, features: [], saq: null, featErr: '',
  passes: [], passFeatures: [], passNow: null, passErr: '', passSkew: 0, passNew: null,
  tickets: [], ticketStats: null, ticketErr: '', ticketOpenOnly: true,
  flags: [], flagStats: null, flagErr: '', flagAll: false, flagLimit: 50,
  corrections: [], corrErr: '',
  guards: null, guardErr: '' };
var aiUid = 0;
/* gen moves on with every fresh load and every teardown, so an answer that lands after either
   is dropped instead of painting over newer rows or a signed out page. */
function aiChatsFresh(gen) {
  return { list: [], stats: null, err: '', more: false, busy: false, exporting: false, gen: gen || 0 };
}
var aiChats = aiChatsFresh(0);

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* Caps are round money and print like money. Spend is not: a grade can cost a fraction of
   a cent, so rounding it to the nearest cent would show nothing all week and then a dollar.
   Four places is enough to watch a number climb. */
function dollars(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }
function spendDollars(cents) { return '$' + (Number(cents || 0) / 100).toFixed(4); }
/* The ledger counts microcents, a millionth of a cent, so 1e8 of them make a dollar. */
function microDollars(mc) { return '$' + (Number(mc || 0) / 1e8).toFixed(4); }
/* For the one line a closed group shows: whole cents, and a fraction of one said in words
   rather than printed as $0.00, which would read as nothing spent. */
function shortDollars(cents) {
  var n = Number(cents || 0);
  return n > 0 && n < 1 ? 'under $0.01' : dollars(n);
}
function aiCount(n, word) {
  n = Number(n || 0);
  return n + ' ' + word + (n === 1 ? '' : 's');
}
function aiWhen(ts) {
  var d = ts ? new Date(ts) : null;
  return d && !isNaN(d.getTime())
    ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
}

function aiCostPerGrade(m) {
  if (m.in_per_mtok == null || m.out_per_mtok == null) return null;
  return (Number(m.in_per_mtok) * AI_IN_TOKENS + Number(m.out_per_mtok) * AI_OUT_TOKENS) / 1e6;
}

function aiModelMeta(m) {
  if (!m) return '';
  var cost = aiCostPerGrade(m);
  return [
    m.eval_agreement == null ? 'agreement: no eval yet'
      : 'agreement ' + Math.round(Number(m.eval_agreement) * 100) + '%',
    m.eval_false_points == null ? 'false points: no eval yet'
      : 'false points ' + Math.round(Number(m.eval_false_points) * 100) + '%',
    cost == null ? 'cost: no price' : 'about $' + cost.toFixed(4) + ' a grade',
    m.eval_latency_ms == null ? 'latency: no eval yet'
      : (Number(m.eval_latency_ms) / 1000).toFixed(1) + ' s'
  ].join(' · ');
}

/* Every model some feature is set to: SAQ grading's from the settings row, the rest from
   their own rows. */
function aiModelsInUse() {
  var used = Object.create(null);
  var s = aiState.settings;
  if (s && s.model) used[s.model] = true;
  (aiState.features || []).forEach(function (f) { if (f && f.model) used[f.model] = true; });
  return used;
}

function aiUsesHaiku() {
  return Object.keys(aiModelsInUse()).some(function (id) { return /haiku/.test(id); });
}

function aiNote(text) {
  if (!aiEl) return;
  aiEl.msg.textContent = text || '';
  aiEl.msg.hidden = !text;
}

function aiShowAt(node, text) {
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
}

function aiErrText(err) {
  var m = err && err.message;
  if (m === 'http_404') return 'Run 0010_ai_grading.sql and 0011_ai_features.sql in Supabase to turn this on.';
  if (m === 'rate_limited') return 'Too many tries from this network. Wait a few minutes.';
  return 'Could not reach the server.';
}

function aiRefusal(r) {
  if (r && r.error === 'forbidden') return 'That admin session was refused. Sign in again.';
  if (r && r.error === 'not_found') return 'The server has no such feature. Refresh and try again.';
  return 'Could not save that.';
}

function aiRangeText(field) {
  if (field === 'daily_cents') {
    return 'The server refused that: ' + dollars(AI_FEATURE_CAP.min) + ' to ' + dollars(AI_FEATURE_CAP.max) + '.';
  }
  if (field === 'model') return 'The server refused that model. Pick one that is on.';
  if (field === 'mode') return 'The server refused that choice.';
  if (field === 'effort') return 'The server refused that effort.';
  return 'The server refused that value.';
}

/* The server is the one that decides what is in range, so its verdict is what gets
   printed, beside the field it names rather than at the top where it would be guessed at.
   admin_ai_set carries the master switch, the caps, effort, and SAQ grading's mode and
   model, so a refusal of any of those is routed to where that control sits. */
function aiShowError(r, row) {
  if (!aiEl) return;
  var field = r && r.error === 'range' ? r.field : null;
  if (field && aiEl.cap[field]) {
    var f = null;
    AI_FIELDS.forEach(function (x) { if (x.key === field) f = x; });
    var lo = f.money ? dollars(f.min) : f.min;
    var hi = f.money ? dollars(f.max) : f.max;
    aiShowAt(aiEl.cap[field].err, 'The server refused that: ' + lo + ' to ' + hi + '.');
    return;
  }
  var saq = aiEl.rows.saq;
  if (field === 'effort') { aiShowAt(aiEl.effortErr, aiRangeText(field)); return; }
  if (field === 'enabled') { aiShowAt(aiEl.masterErr, aiRangeText(field)); return; }
  if ((field === 'mode' || field === 'model') && saq) {
    aiShowAt(field === 'mode' ? saq.modeErr : saq.modelErr, aiRangeText(field));
    return;
  }
  var text = field ? aiRangeText(field) : aiRefusal(r);
  if (row) aiShowAt(row.msg, text); else aiNote(text);
}

function aiClearFieldErrors() {
  if (!aiEl) return;
  AI_FIELDS.forEach(function (f) {
    aiEl.cap[f.key].err.hidden = true;
    aiEl.cap[f.key].err.textContent = '';
  });
  [aiEl.effortErr, aiEl.masterErr].forEach(function (n) { n.hidden = true; n.textContent = ''; });
}

function aiDisable(list, on) {
  list.forEach(function (n) { if (n) n.disabled = !!on; });
}

/* ---- building blocks ---- */

function aiGroupsRead() {
  try {
    var o = JSON.parse(localStorage.getItem(AI_GROUPS_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}

function aiGroupsWrite(name, open) {
  try {
    var o = aiGroupsRead();
    o[name] = !!open;
    localStorage.setItem(AI_GROUPS_KEY, JSON.stringify(o));
  } catch (e) {}
}

/* Eleven groups in one flat list is a list nobody reads. They go under four headings instead,
   by the question the owner came in with: what is this costing, what is it allowed to do, who
   may use it, what has it done. Nothing moves out of the panel and no group is merged away, so
   anything the owner already knows where to find is still exactly where it was, one heading
   further in. */
function aiSection(parent, title, sub) {
  var wrap = el('div', 'aisection');
  var h = el('div', 'aisectionhead');
  h.appendChild(el('span', 'aisectionname', title));
  if (sub) h.appendChild(el('span', 'aisectionsub', sub));
  wrap.appendChild(h);
  var body = el('div', 'aigroups');
  wrap.appendChild(body);
  parent.appendChild(wrap);
  return body;
}

/* A closed group is one line: its name, the numbers worth seeing without opening it, and a
   chevron. */
function aiGroup(parent, name, title) {
  var det = el('details', 'aigroup');
  det.open = aiGroupsRead()[name] === true;
  var sum = el('summary', 'aisum');
  sum.appendChild(el('span', 'aisumtitle', title));
  var state = el('span', 'aisumstate');
  sum.appendChild(state);
  var chev = el('span', 'aichev');
  chev.setAttribute('aria-hidden', 'true');
  sum.appendChild(chev);
  var body = el('div', 'aigroupbody');
  det.appendChild(sum);
  det.appendChild(body);
  det.addEventListener('toggle', function () { aiGroupsWrite(name, det.open); });
  parent.appendChild(det);
  return { det: det, state: state, body: body };
}

function aiSwitch(label) {
  var b = el('button', 'aiswitch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', 'false');
  if (label) b.setAttribute('aria-label', label);
  return b;
}

function aiSwitchOn(b) { return b.getAttribute('aria-checked') === 'true'; }

function aiSeg() {
  var wrap = el('div', 'aiseg');
  wrap.setAttribute('role', 'group');
  var owner = el('button', null, 'Owner only');
  var open = el('button', null, 'Open with caps');
  [owner, open].forEach(function (b) {
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    wrap.appendChild(b);
  });
  return { wrap: wrap, owner: owner, open: open };
}

/* A label, the control, and the line under it where the server's refusal is printed. */
function aiField(cls, text, control) {
  var f = el('div', 'aifield' + (cls ? ' ' + cls : ''));
  var id = 'aif-' + (++aiUid);
  var lab;
  if (control.tagName === 'INPUT' || control.tagName === 'SELECT' || control.tagName === 'TEXTAREA') {
    lab = el('label', 'lbl', text);
    control.id = id;
    lab.setAttribute('for', id);
  } else {
    lab = el('span', 'lbl', text);
    lab.id = id;
    control.setAttribute('aria-labelledby', id);
  }
  f.appendChild(lab);
  f.appendChild(control);
  var err = el('p', 'err-inline');
  err.hidden = true;
  f.appendChild(err);
  return { field: f, err: err };
}

function aiTextInput() {
  var inp = document.createElement('input');
  inp.type = 'text';
  inp.inputMode = 'decimal';
  inp.className = 'aiinput';
  inp.autocomplete = 'off';
  return inp;
}

/* For words rather than money: the fields above ask a phone for a number pad, which is wrong
   for a topic or a sentence. rows above one gives a box that can be dragged taller. */
function aiWordsInput(rows) {
  var n;
  if (rows > 1) {
    n = document.createElement('textarea');
    n.rows = rows;
    n.className = 'aiinput aiarea';
  } else {
    n = document.createElement('input');
    n.type = 'text';
    n.className = 'aiinput';
  }
  n.autocomplete = 'off';
  return n;
}

/* A row of tabs over one pane each. The panel was ten folds under four headings, seven
   thousand pixels tall with them open; a tab shows one question's worth at a time and the
   strip above them carries what used to need three folds opened to see. Left and Right move
   along the row, as a tablist should. Which tab was open is a per browser convenience. */
function aiTabs(parent, defs) {
  var bar = el('div', 'aitabs');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Ask settings');
  parent.appendChild(bar);
  var t = { bar: bar, tabs: {}, panes: {}, badges: {}, order: [], current: null };
  defs.forEach(function (d) {
    var b = el('button', 'aitab');
    b.type = 'button';
    b.id = 'aitab-' + d.id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', 'false');
    b.setAttribute('aria-controls', 'aipane-' + d.id);
    b.tabIndex = -1;
    b.appendChild(el('span', null, d.title));
    var badge = el('span', 'aitabbadge');
    badge.hidden = true;
    b.appendChild(badge);
    bar.appendChild(b);
    var pane = el('div', 'aipane');
    pane.id = 'aipane-' + d.id;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', b.id);
    pane.hidden = true;
    parent.appendChild(pane);
    t.tabs[d.id] = b; t.panes[d.id] = pane; t.badges[d.id] = badge; t.order.push(d.id);
    b.addEventListener('click', function () { t.select(d.id); });
  });
  t.select = function (id, focus) {
    if (!t.panes[id]) id = t.order[0];
    t.current = id;
    t.order.forEach(function (k) {
      var on = k === id;
      t.tabs[k].setAttribute('aria-selected', String(on));
      t.tabs[k].tabIndex = on ? 0 : -1;
      t.panes[k].hidden = !on;
    });
    try { localStorage.setItem(AI_TAB_KEY, id); } catch (e) {}
    if (focus) { try { t.tabs[id].focus(); } catch (e) {} }
    try { if (t.tabs[id].scrollIntoView) t.tabs[id].scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  };
  t.badge = function (id, n) {
    var b = t.badges[id];
    if (!b) return;
    n = Number(n) || 0;
    b.textContent = n > 0 ? String(n) : '';
    b.hidden = !(n > 0);
  };
  bar.addEventListener('keydown', function (ev) {
    var step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    var i = t.order.indexOf(t.current);
    t.select(t.order[(i + step + t.order.length) % t.order.length], true);
  });
  var stored = null;
  try { stored = localStorage.getItem(AI_TAB_KEY); } catch (e) {}
  t.select(stored || t.order[0]);
  return t;
}

/* A thin bar with its numbers over it: spent against a ceiling, amber near it, red at it. */
function aiMeter(name) {
  var wrap = el('div', 'aimeter');
  var top = el('div', 'aimetertop');
  top.appendChild(el('span', 'aimetername', name));
  var val = el('span', 'aimeterval');
  top.appendChild(val);
  wrap.appendChild(top);
  var track = el('div', 'aimetertrack');
  var fill = el('div', 'aimeterfill');
  track.appendChild(fill);
  wrap.appendChild(track);
  return { wrap: wrap, val: val, fill: fill };
}

function aiMeterPaint(m, spent, cap, text) {
  spent = Number(spent) || 0;
  cap = Number(cap) || 0;
  var share = cap > 0 ? spent / cap : (spent > 0 ? 1 : 0);
  m.fill.style.width = Math.max(0, Math.min(100, share * 100)).toFixed(1) + '%';
  m.wrap.classList.toggle('near', share >= 0.85 && share < 1);
  m.wrap.classList.toggle('full', share >= 1);
  m.val.textContent = text;
}

/* A small heading inside a pane, with one line under it where one is needed. */
function aiBlock(parent, title, sub) {
  var wrap = el('div', 'aiblockpart');
  wrap.appendChild(el('h4', 'aiblockname', title));
  if (sub) wrap.appendChild(el('p', 'aiblocksub', sub));
  parent.appendChild(wrap);
  return wrap;
}

/* The word Saved beside a field for a moment. Every number in the panel saves when it is left,
   so this is the only sign that it did. */
function aiTick(node) {
  if (!node) return;
  node.textContent = 'Saved';
  clearTimeout(node._t);
  node._t = setTimeout(function () { node.textContent = ''; }, 1800);
}

/* Go to a tab, open a fold in it, and put the cursor on a control: what the strip's buttons and
   a feature's spend figure do, so a warning is one tap from the thing that answers it. */
function aiGo(tab, group, node) {
  if (!aiEl) return;
  aiEl.tabs.select(tab);
  if (group && group.det) group.det.open = true;
  var to = node || (group && group.det) || aiEl.tabs.panes[tab];
  try { to.scrollIntoView({ block: 'center' }); } catch (e) {}
  if (node) { try { node.focus(); if (node.select) node.select(); } catch (e) {} }
}

function buildAi(sec) {
  var e = { cap: {}, rows: Object.create(null), capRows: Object.create(null), groups: Object.create(null) };

  var head = el('div', 'aihead');
  head.appendChild(el('h3', 'rubric', 'Switches and spending'));
  e.refresh = el('button', 'ailink', 'Refresh');
  e.refresh.type = 'button';
  head.appendChild(e.refresh);
  sec.appendChild(head);
  sec.appendChild(el('p', 'note',
    'Nothing runs unless it is switched on here and the material carries its tag (the Ask button ' +
    'on each row above). What a student types goes to Anthropic for the answer.'));

  e.msg = el('p', 'err-inline');
  e.msg.hidden = true;
  sec.appendChild(e.msg);

  e.body = el('div', 'aisections');
  sec.appendChild(e.body);

  /* ---- the strip: always on screen ---- */
  /* The two switches that hold everything else, what has been spent against the two ceilings
     that count, and whatever needs the owner, each with the button that deals with it. */
  var strip = el('div', 'aistrip');
  var sws = el('div', 'aistripsw');
  var master = el('div', 'aimaster');
  var mt = el('div', 'aimastertext');
  mt.appendChild(el('span', 'aimastername', 'Everything Ask can do'));
  mt.appendChild(el('span', 'aimeta', 'Off holds every feature, whatever its own switch says.'));
  master.appendChild(mt);
  e.master = aiSwitch('Everything Ask can do');
  master.appendChild(e.master);
  sws.appendChild(master);

  var gplain = el('div', 'aimaster');
  var gpt = el('div', 'aimastertext');
  gpt.appendChild(el('span', 'aimastername', 'Plain mode'));
  gpt.appendChild(el('span', 'aimeta', 'On means Ask is one call with no extras.'));
  gplain.appendChild(gpt);
  e.guardPlain = aiSwitch('Plain mode');
  gplain.appendChild(e.guardPlain);
  sws.appendChild(gplain);
  strip.appendChild(sws);

  e.masterErr = el('p', 'err-inline');
  e.masterErr.hidden = true;
  strip.appendChild(e.masterErr);
  /* Plain mode is the one setting that changes what Ask does rather than what it may spend, so
     when it is on the panel says so in full rather than leaving a switch to be read. */
  e.guardPlainOn = el('p', 'aiheld',
    'Plain mode is on. Ask is back to a single call with no extras: no reranking, no retry, ' +
    'no research, no deep answers, whatever each of those says under Features.');
  e.guardPlainOn.hidden = true;
  strip.appendChild(e.guardPlainOn);

  var meters = el('div', 'aimeters');
  e.meterDay = aiMeter('Today');
  e.meterMonth = aiMeter('This month');
  meters.appendChild(e.meterDay.wrap);
  meters.appendChild(e.meterMonth.wrap);
  strip.appendChild(meters);
  e.codesLine = el('p', 'aimeta aicodesline');
  e.codesLine.hidden = true;
  strip.appendChild(e.codesLine);

  e.attn = el('ul', 'aiattn');
  strip.appendChild(e.attn);
  e.body.appendChild(strip);

  e.tabs = aiTabs(e.body, [
    { id: 'features', title: 'Features' },
    { id: 'limits', title: 'Limits' },
    { id: 'people', title: 'People' },
    { id: 'activity', title: 'Activity' }
  ]);
  var pFeat = e.tabs.panes.features, pLim = e.tabs.panes.limits;

  /* ---- Features: what is on, who may use it, which model ---- */
  e.held = el('p', 'aiheld', 'Everything Ask can do is off, so nothing here can run.');
  e.held.hidden = true;
  pFeat.appendChild(e.held);
  e.featNote = el('p', 'err-inline');
  e.featNote.hidden = true;
  pFeat.appendChild(e.featNote);
  pFeat.appendChild(el('p', 'note',
    'A row is its name, what it has spent against its own cap today, and its switch. Open a ' +
    'row for who may use it and which model. The caps themselves are all under Limits.'));

  AI_FEATURE_GROUPS.forEach(function (g) {
    var wrap, list = el('ul', 'aifeats');
    var count = el('span', 'aifeatgroupcount');
    if (g.folded) {
      wrap = el('details', 'aifeatgroup aifeatfold');
      var sum = el('summary', 'aifeatgrouphead');
      sum.appendChild(el('span', 'aiblockname', g.title));
      sum.appendChild(count);
      var chev = el('span', 'aichev');
      chev.setAttribute('aria-hidden', 'true');
      sum.appendChild(chev);
      wrap.appendChild(sum);
    } else {
      wrap = el('div', 'aifeatgroup');
      var h = el('div', 'aifeatgrouphead');
      h.appendChild(el('h4', 'aiblockname', g.title));
      h.appendChild(count);
      wrap.appendChild(h);
    }
    if (g.sub) wrap.appendChild(el('p', 'aiblocksub', g.sub));
    wrap.appendChild(list);
    wrap.hidden = true;
    pFeat.appendChild(wrap);
    e.groups[g.id] = { wrap: wrap, list: list, count: count };
  });

  var extras = el('div', 'aigroups');
  pFeat.appendChild(extras);
  e.modelsGroup = aiGroup(extras, 'models', 'Effort and models');
  /* Effort is read off the settings row by every feature, not off a model row, so that is
     where it is written. The model row's own effort column is the eval's record of which
     setting was measured, and only the eval writes it. */
  e.effort = document.createElement('select');
  e.effort.className = 'aisel';
  ['low', 'medium'].forEach(function (v) {
    var o = document.createElement('option');
    o.value = v; o.textContent = v;
    e.effort.appendChild(o);
  });
  var eff = aiField('aieffort', 'Effort, every feature', e.effort);
  e.effortErr = eff.err;
  /* Haiku 4.5 has no adaptive thinking, so for a feature on it the effort is a no op. */
  e.effortHint = el('p', 'aimeta', 'Haiku has no adaptive thinking and ignores this.');
  e.effortHint.hidden = true;
  eff.field.insertBefore(e.effortHint, eff.err);
  e.modelsGroup.body.appendChild(eff.field);
  /* The selects alone would make each choice blind. This list is the reason for the choice:
     what the eval measured, and what one grade costs at that model's prices. */
  e.models = el('div', 'aimodels');
  e.modelsGroup.body.appendChild(e.models);

  /* ---- Limits: every number that holds spending, in one place ---- */
  pLim.appendChild(el('p', 'note',
    'Every number here saves when you leave the field. The first three blocks are in dollars; ' +
    'one question and the breaker are in cents, because one answer costs a cent or two.'));

  var bAcct = aiBlock(pLim, 'Your account',
    'Counts every feature. Money a code spends comes off that code and never touches these.');
  e.caps = el('div', 'aicaps');
  var bVis = null, visCaps = el('div', 'aicaps aicaps3');
  AI_FIELDS.forEach(function (f) {
    var inp = aiTextInput();
    var fld = aiField('aicap', f.label + (f.money ? ' ($)' : ''), inp);
    var tick = el('span', 'aisaved');
    fld.field.appendChild(tick);
    e.cap[f.key] = { input: inp, err: fld.err, tick: tick };
    (f.money ? e.caps : visCaps).appendChild(fld.field);
  });
  /* Today only (0016). It is not one of the stored caps: it lifts the daily ceiling until the
     next day boundary and then lapses, so a cram night never quietly becomes the new normal. */
  e.bonus = aiTextInput();
  var bf = aiField('aicap', 'Extra for today only ($)', e.bonus);
  e.bonusErr = bf.err;
  e.bonusTick = el('span', 'aisaved');
  bf.field.appendChild(e.bonusTick);
  e.caps.appendChild(bf.field);
  e.caps.classList.add('aicaps3');
  bAcct.appendChild(e.caps);
  e.bonus.addEventListener('input', function () { e.bonus.setAttribute('data-editing', '1'); });
  e.bonus.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') e.bonus.blur(); });
  e.bonus.addEventListener('change', function () {
    e.bonus.removeAttribute('data-editing');
    e.bonusErr.hidden = true;
    var raw = e.bonus.value.trim().replace(/^\$/, '');
    var n = raw === '' ? 0 : Number(raw);
    if (!isFinite(n) || n < 0) { aiShowAt(e.bonusErr, 'Numbers only.'); return; }
    aiBonusSet(null, Math.round(n * 100), e.bonusErr).then(function (r) {
      if (r !== null && !(r && r.ok === false)) aiTick(e.bonusTick);
    });
  });

  /* Each feature's own daily cap, which sits inside the account's. One line each, so the whole
     ladder of ceilings can be read top to bottom instead of one fold at a time. */
  var bFeat = aiBlock(pLim, 'Each feature, per day',
    'Inside the account caps. A feature at its own cap refuses until tomorrow, whatever is left above it.');
  var capHead = el('div', 'aicaprow aicaphead');
  ['Feature', 'Spent today', 'Daily cap, $', 'Extra today, $'].forEach(function (t) {
    capHead.appendChild(el('span', null, t));
  });
  capHead.setAttribute('aria-hidden', 'true');
  bFeat.appendChild(capHead);
  e.capList = el('ul', 'aicaplist');
  bFeat.appendChild(e.capList);

  bVis = aiBlock(pLim, 'Requests',
    'The two call limits hold a feature set to Open with caps; Owner only takes your session and ' +
    'skips them. Max characters holds every request. The monthly cap is the one that cannot be ' +
    'talked around: a device id is spoofable, a spend ceiling is not.');
  bVis.appendChild(visCaps);

  /* What one Ask answer may cost, whatever the switches say (0033). In cents, not the dollars
     the caps are typed in: one answer costs a fraction of a cent, so a ceiling written in
     dollars would be four zeroes and a guess. Every label says cents.

     Reading these values recomputes the breaker on the server and writes a row, so they are
     read when the panel loads and when the owner asks, and never on a timer. */
  var bOne = aiBlock(pLim, 'One question',
    'The most a single question may add up to, extras included. Past it the extra is refused and the ordinary answer goes ahead.');
  var gnums = el('div', 'aicaps');
  e.guardCeiling = aiTextInput();
  var gc = aiField('aicap', 'Ceiling (cents)', e.guardCeiling);
  e.guardCeilingErr = gc.err;
  gnums.appendChild(gc.field);
  /* Deep research has its own ceiling because a deep question is meant to cost about 12 cents:
     on the shared one every deep question would be refused by arithmetic (migration 0034). */
  e.guardDeep = aiTextInput();
  var gd = aiField('aicap', 'Ceiling, deep question (cents)', e.guardDeep);
  e.guardDeepErr = gd.err;
  gnums.appendChild(gd.field);
  bOne.appendChild(gnums);

  var bBrk = aiBlock(pLim, 'Breaker',
    'Reads the last twenty answers. Past the soft line it pauses the dearest extras, past the ' +
    'hard line all of them, and one on its own if it fires too often. It never pauses Ask itself.');
  var bon = el('div', 'aimaster');
  var bont = el('div', 'aimastertext');
  bont.appendChild(el('span', 'aimastername', 'Breaker'));
  e.guardState = el('span', 'aimeta');
  bont.appendChild(e.guardState);
  bon.appendChild(bont);
  e.guardOn = aiSwitch('Breaker');
  bon.appendChild(e.guardOn);
  bBrk.appendChild(bon);
  e.guardOnErr = el('p', 'err-inline');
  e.guardOnErr.hidden = true;
  bBrk.appendChild(e.guardOnErr);
  var bnums = el('div', 'aicaps');
  e.guardBreaker = aiTextInput();
  var gb = aiField('aicap', 'Soft line, running mean (cents)', e.guardBreaker);
  e.guardBreakerErr = gb.err;
  bnums.appendChild(gb.field);
  e.guardHard = aiTextInput();
  var gh = aiField('aicap', 'Hard line, running mean (cents)', e.guardHard);
  e.guardHardErr = gh.err;
  bnums.appendChild(gh.field);
  bBrk.appendChild(bnums);

  e.guardRead = el('p', 'aireadout');
  bBrk.appendChild(e.guardRead);
  e.guardPaused = el('ul', 'aichips');
  bBrk.appendChild(e.guardPaused);
  e.guardWhy = el('p', 'aiheld');
  e.guardWhy.hidden = true;
  bBrk.appendChild(e.guardWhy);

  var grow = el('div', 'row wrap aipassctl');
  e.guardClear = el('button', 'btn sm out', 'Clear the pause');
  e.guardClear.type = 'button';
  grow.appendChild(e.guardClear);
  e.guardRefresh = el('button', 'btn sm out', 'Read them again');
  e.guardRefresh.type = 'button';
  grow.appendChild(e.guardRefresh);
  bBrk.appendChild(grow);
  e.guardNote = el('p', 'err-inline');
  e.guardNote.hidden = true;
  bBrk.appendChild(e.guardNote);
  /* aiPaintGuards writes its one line summary here, where the fold's closed line used to be. */
  e.guardGroup = { state: e.guardState };

  e.guardPlain.addEventListener('click', function () {
    aiGuardSet('plain', null, !aiSwitchOn(e.guardPlain), e.masterErr, [e.guardPlain]);
  });
  e.guardOn.addEventListener('click', function () {
    aiGuardSet('breaker_on', null, !aiSwitchOn(e.guardOn), e.guardOnErr, [e.guardOn]);
  });
  [[e.guardCeiling, 'ceiling', e.guardCeilingErr],
   [e.guardDeep, 'deep_ceiling', e.guardDeepErr],
   [e.guardBreaker, 'breaker', e.guardBreakerErr],
   [e.guardHard, 'hard', e.guardHardErr]].forEach(function (pair) {
    var inp = pair[0], key = pair[1], errAt = pair[2];
    inp.addEventListener('input', function () { inp.setAttribute('data-editing', '1'); });
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', function () { aiGuardNumChange(inp, key, errAt); });
  });
  e.guardClear.addEventListener('click', function () {
    aiGuardSet('reset', null, null, e.guardNote, [e.guardClear]);
  });
  e.guardRefresh.addEventListener('click', function () { aiLoadGuards(); });

  /* The folds below keep the parents they always had by name: who may use it, and what it has
     done. Corrections sit beside Flags now, because one is the answer to the other. */
  e.secWho = el('div', 'aigroups');
  e.tabs.panes.people.appendChild(e.secWho);
  e.secDone = el('div', 'aigroups');
  e.tabs.panes.activity.appendChild(e.secDone);
  e.secDoes = e.secDone;

  /* ---- Codes ---- */
  e.passGroup = aiGroup(e.secWho, 'passes', 'Codes');
  e.passGroup.body.appendChild(el('p', 'note',
    'A code is one person: it saves their progress under that code and lets them use Ask ' +
    'features you tick, out of money you load onto it. It carries none of your own rights. ' +
    'Switch it off, end it, or let it end by itself in the morning. A code\'s end time is New York ' +
    'time. Your caps above still hold, and they run on a different clock: the day turns over at ' +
    '8pm New York, 7pm in winter.'));

  var pmake = el('div', 'aipassmake');
  e.passLabel = aiTextInput();
  pmake.appendChild(aiField('aipassf', 'Who it is for', e.passLabel).field);
  e.passMoney = aiTextInput();
  pmake.appendChild(aiField('aipassf', 'Money on it (dollars)', e.passMoney).field);
  e.passWhen = document.createElement('select');
  e.passWhen.className = 'aisel';
  [['none', 'No end date'], ['morning', 'Ends tomorrow 7am'], ['hours', 'Ends in 3 hours']].forEach(function (o) {
    var opt = document.createElement('option');
    opt.value = o[0];
    opt.textContent = o[1];
    e.passWhen.appendChild(opt);
  });
  pmake.appendChild(aiField('aipassf', 'When it ends', e.passWhen).field);
  e.passAsk = aiSwitch('Ask about the material');
  e.passAsk.setAttribute('aria-checked', 'true');
  pmake.appendChild(aiField('aipassf aipasssw', 'Ask', e.passAsk).field);
  e.passDaily = aiTextInput();
  pmake.appendChild(aiField('aipassf', 'Their daily cap (dollars)', e.passDaily).field);
  /* The textbook is the owner's own copy of their course book. Handing passages of it to someone
     else is their call to make per person, so it is a tick rather than a rule. */
  e.passBook = aiSwitch('May use the textbook');
  pmake.appendChild(aiField('aipassf aipasssw', 'Textbook', e.passBook).field);
  /* Everything the owner has, including anything added later, minus what is switched off on the
     code itself. */
  e.passAll = aiSwitch('Everything the owner has');
  pmake.appendChild(aiField('aipassf aipasssw', 'All features', e.passAll).field);
  e.passGroup.body.appendChild(pmake);

  var prow = el('div', 'row wrap');
  e.passMake = el('button', 'btn sm', 'Make a code');
  e.passMake.type = 'button';
  prow.appendChild(e.passMake);
  e.passErr = el('span', 'err-inline aipasserr');
  e.passErr.hidden = true;
  prow.appendChild(e.passErr);
  e.passGroup.body.appendChild(prow);

  e.passNew = el('div', 'aipassnew');
  e.passNew.hidden = true;
  e.passGroup.body.appendChild(e.passNew);

  e.passList = el('ul', 'aipasslist');
  e.passGroup.body.appendChild(e.passList);
  e.passNote = el('p', 'err-inline');
  e.passNote.hidden = true;
  e.passGroup.body.appendChild(e.passNote);
  e.passMake.addEventListener('click', aiPassCreate);

  /* ---- Reports ---- */
  e.ticketGroup = aiGroup(e.secWho, 'tickets', 'Reports');
  e.ticketGroup.body.appendChild(el('p', 'note',
    'Problems people reported from inside a material, with the tab and the card they were on. ' +
    'Anyone can file one: Alt and B in a material, or a thumbs down on an answer.'));
  var trow = el('div', 'row wrap');
  e.ticketFilter = el('button', 'btn sm out', 'Open only');
  e.ticketFilter.type = 'button';
  e.ticketFilter.setAttribute('aria-pressed', 'true');
  trow.appendChild(e.ticketFilter);
  e.ticketRefresh = el('button', 'btn sm out', 'Refresh');
  e.ticketRefresh.type = 'button';
  trow.appendChild(e.ticketRefresh);
  e.ticketGroup.body.appendChild(trow);
  e.ticketList = el('ul', 'aitickets');
  e.ticketGroup.body.appendChild(e.ticketList);
  e.ticketNote = el('p', 'err-inline');
  e.ticketNote.hidden = true;
  e.ticketGroup.body.appendChild(e.ticketNote);
  e.ticketFilter.addEventListener('click', function () {
    aiState.ticketOpenOnly = !aiState.ticketOpenOnly;
    e.ticketFilter.setAttribute('aria-pressed', String(aiState.ticketOpenOnly));
    e.ticketFilter.textContent = aiState.ticketOpenOnly ? 'Open only' : 'All of them';
    aiLoadTickets();
  });
  e.ticketRefresh.addEventListener('click', function () { aiLoadTickets(); });

  /* ---- Flags ---- */
  /* What the page's own checks caught in an answer (0033): the sentence itself, so it can be
     read and turned into a correction rather than only counted. There is no cursor, only a
     limit, so the list asks for the newest however many rather than paging. */
  e.flagGroup = aiGroup(e.secDone, 'flags', 'Flags');
  e.flagGroup.body.appendChild(el('p', 'note',
    'A sentence the checks on the page could not back against the material, newest first, with ' +
    'the question that produced it. Correcting one writes what is true in your words, and the ' +
    'next question that carries every word of the topic gets it, and it outranks the material\'s own passages.'));
  var flrow = el('div', 'row wrap');
  e.flagAll = el('button', 'btn sm out', 'Open only');
  e.flagAll.type = 'button';
  e.flagAll.setAttribute('aria-pressed', 'true');
  flrow.appendChild(e.flagAll);
  e.flagLimit = document.createElement('select');
  e.flagLimit.className = 'aisel aiflaglimit';
  e.flagLimit.setAttribute('aria-label', 'How many flags to show');
  AI_FLAG_LIMITS.forEach(function (n) {
    var o = document.createElement('option');
    o.value = String(n);
    o.textContent = 'Newest ' + n;
    e.flagLimit.appendChild(o);
  });
  e.flagLimit.value = String(aiState.flagLimit);
  flrow.appendChild(e.flagLimit);
  e.flagRefresh = el('button', 'btn sm out', 'Refresh');
  e.flagRefresh.type = 'button';
  flrow.appendChild(e.flagRefresh);
  e.flagGroup.body.appendChild(flrow);
  e.flagStats = el('p', 'aireadout');
  e.flagGroup.body.appendChild(e.flagStats);
  e.flagList = el('ul', 'aitickets');
  e.flagGroup.body.appendChild(e.flagList);
  e.flagNote = el('p', 'err-inline');
  e.flagNote.hidden = true;
  e.flagGroup.body.appendChild(e.flagNote);
  e.flagAll.addEventListener('click', function () {
    aiState.flagAll = !aiState.flagAll;
    e.flagAll.setAttribute('aria-pressed', String(!aiState.flagAll));
    e.flagAll.textContent = aiState.flagAll ? 'Reviewed as well' : 'Open only';
    aiLoadFlags();
  });
  e.flagLimit.addEventListener('change', function () {
    var n = Number(e.flagLimit.value);
    aiState.flagLimit = isFinite(n) && n > 0 ? n : 50;
    aiLoadFlags();
  });
  e.flagRefresh.addEventListener('click', function () { aiLoadFlags(); });

  /* ---- Corrections ---- */
  e.corrGroup = aiGroup(e.secDoes, 'corrections', 'Corrections');
  e.corrGroup.body.appendChild(el('p', 'note',
    'What you wrote after reading a flagged answer. A correction goes out with any question that ' +
    'carries every word of its topic, and it outranks the material\'s own passages. Nothing here ' +
    'is deleted: switch one off and it stops being sent.'));
  var crow = el('div', 'row wrap');
  e.corrRefresh = el('button', 'btn sm out', 'Refresh');
  e.corrRefresh.type = 'button';
  crow.appendChild(e.corrRefresh);
  e.corrGroup.body.appendChild(crow);
  e.corrList = el('ul', 'aitickets');
  e.corrGroup.body.appendChild(e.corrList);
  e.corrNote = el('p', 'err-inline');
  e.corrNote.hidden = true;
  e.corrGroup.body.appendChild(e.corrNote);
  e.corrRefresh.addEventListener('click', function () { aiLoadCorrections(); });

  /* ---- Recent calls ---- */
  e.callsGroup = aiGroup(e.secDone, 'calls', 'Recent calls');
  e.calls = el('div', 'aicalls');
  e.callsGroup.body.appendChild(e.calls);

  /* ---- Chats ---- */
  /* Saved Ask conversations (0012), so the beta can be judged on what it actually said: the
     newest twenty, one line each until opened, a rating that saves as it is tapped, and an
     export of the lot. Every string in a row came from the server and goes in as text. */
  e.chatsGroup = aiGroup(e.secDone, 'chats', 'Chats');
  e.chatBar = el('div', 'aichatbar');
  e.chatBar.hidden = true;
  e.chatExport = el('button', 'btn ghost sm aichatbtn', 'Export');
  e.chatExport.type = 'button';
  e.chatExportMsg = el('span', 'aichatstatus');
  e.chatExportMsg.setAttribute('role', 'status');
  e.chatBar.appendChild(e.chatExport);
  e.chatBar.appendChild(e.chatExportMsg);
  e.chatsGroup.body.appendChild(e.chatBar);
  e.chatNote = el('p', 'err-inline');
  e.chatNote.hidden = true;
  e.chatsGroup.body.appendChild(e.chatNote);
  e.chatEmpty = el('p', 'note', 'No chats saved yet.');
  e.chatEmpty.hidden = true;
  e.chatsGroup.body.appendChild(e.chatEmpty);
  e.chatList = el('ul', 'aichats');
  e.chatsGroup.body.appendChild(e.chatList);
  e.chatMore = el('button', 'btn ghost sm aichatbtn aichatmore', 'Show more');
  e.chatMore.type = 'button';
  e.chatMore.hidden = true;
  e.chatsGroup.body.appendChild(e.chatMore);

  return e;
}

/* One row per feature. The row is built once and repainted in place, so a save elsewhere in
   the section never moves a control someone is using. Closed, a row is a name, what it has
   spent against its own cap, and its switch: eleven of them fit on a screen. The rest of what
   a feature has (who may use it, which model, and for Ask the two switches that are only
   Ask's) is inside the row, behind its name. Its caps are under Limits with all the others. */
function aiFeatRow(id) {
  var saq = id === 'saq';
  var r = { id: id, saq: saq };
  r.li = el('li', 'aifeat');

  var head = el('div', 'aifeathead');
  r.open = el('button', 'aifeatopen');
  r.open.type = 'button';
  r.open.setAttribute('aria-expanded', 'false');
  var title = el('span', 'aifeattitle');
  r.name = el('span', 'aifeatname');
  r.beta = el('span', 'aibeta', 'Beta');
  r.beta.hidden = true;
  r.paused = el('span', 'aichip aichipflags', 'Paused');
  r.paused.hidden = true;
  title.appendChild(r.name);
  title.appendChild(r.beta);
  title.appendChild(r.paused);
  r.open.appendChild(title);
  var chev = el('span', 'aichev');
  chev.setAttribute('aria-hidden', 'true');
  r.open.appendChild(chev);
  head.appendChild(r.open);

  /* What this feature has spent against its own cap today. A feature could refuse an answer at
     its own ceiling while the only number on screen was the account's, with most of a dollar
     still free; that is what "you hit your limit" looked like with 62 cents left. It is a
     button because the next thing anyone wants after reading it is the cap it is measured on. */
  r.spent = el('button', 'aifeatspend');
  r.spent.type = 'button';
  r.spentText = el('span', 'aifeatspendtext');
  r.spent.appendChild(r.spentText);
  var track = el('span', 'aimetertrack');
  r.spentFill = el('span', 'aimeterfill');
  track.appendChild(r.spentFill);
  r.spent.appendChild(track);
  head.appendChild(r.spent);

  if (saq) {
    /* SAQ grading predates the features table. Its only switch is the master one. */
    r.fixed = el('span', 'aifixed');
    head.appendChild(r.fixed);
  } else {
    r.sw = aiSwitch();
    head.appendChild(r.sw);
  }
  r.li.appendChild(head);

  r.body = el('div', 'aifeatbody');
  r.body.id = 'aifeatbody-' + (++aiUid);
  r.body.hidden = true;
  r.open.setAttribute('aria-controls', r.body.id);
  r.about = el('p', 'aifeatabout');
  r.about.hidden = true;
  r.body.appendChild(r.about);

  var ctl = el('div', 'aifeatctl');
  var f;
  r.seg = aiSeg();
  f = aiField('aimode', 'Who can use it', r.seg.wrap);
  r.modeField = f.field;
  r.modeErr = f.err;
  ctl.appendChild(f.field);

  r.model = document.createElement('select');
  r.model.className = 'aisel';
  f = aiField('aimodelf', 'Model', r.model);
  r.modelField = f.field;
  r.modelErr = f.err;
  ctl.appendChild(f.field);

  if (!saq) {
    /* Whether an answer may go past the material (0015). It appears on the Ask row alone, because
       since 0036 that row is where the rule lives: one material contract, read by every answer in
       a material, including a retry and a deep one. On the two research modes it would be worse
       than dead: their own rules say to answer from the sources the owner chose, so turning it on
       would send a permission and a prohibition in the same request. */
    r.beyond = aiSwitch('Beyond the material');
    f = aiField('aibeyondf', 'Beyond the material', r.beyond);
    f.field.insertBefore(el('p', 'aimeta',
      'Applies to every answer in a material, including a retry and a deep one. A research answer '
      + 'is always made of the sources you chose and never goes past them.'), f.err);
    r.beyondField = f.field;
    r.beyondErr = f.err;
    r.beyondField.hidden = true;
    ctl.appendChild(f.field);

    /* The corner Ask button on phones (0028). Off by default: nobody gets a button on screen
       unless this is on, and then only on a touch screen and only someone who may use Ask. */
    r.phone = aiSwitch('Ask button on phones');
    f = aiField('aibeyondf', 'Ask button on phones', r.phone);
    r.phoneField = f.field;
    r.phoneErr = f.err;
    r.phoneField.hidden = true;
    ctl.appendChild(f.field);
  }
  r.body.appendChild(ctl);
  r.meta = el('p', 'aifeatmeta');
  r.body.appendChild(r.meta);
  r.li.appendChild(r.body);

  r.msg = el('p', 'err-inline aifeatmsg');
  r.msg.hidden = true;
  r.li.appendChild(r.msg);

  aiWireRow(r);
  return r;
}

function aiRowControls(r) {
  return [r.sw, r.seg.owner, r.seg.open, r.model, r.beyond, r.phone].filter(Boolean);
}

function aiRowClear(r) {
  [r.modeErr, r.modelErr, r.beyondErr, r.phoneErr, r.msg].forEach(function (n) {
    if (!n) return;
    n.hidden = true;
    n.textContent = '';
  });
}

/* Where a refusal from admin_ai_feature_set is printed for a write that came from this row. */
function aiRowCtx(r) {
  return { busy: aiRowControls(r), msg: r.msg, clear: function () { aiRowClear(r); },
    errs: { mode: r.modeErr, model: r.modelErr, beyond: r.beyondErr, phone_button: r.phoneErr } };
}

function aiWireRow(r) {
  var set = r.saq
    ? function (patch) { return aiSet(patch, r); }
    : function (patch) { return aiFeatureSet(r.id, patch, aiRowCtx(r)); };

  r.open.addEventListener('click', function () {
    var on = r.open.getAttribute('aria-expanded') !== 'true';
    r.open.setAttribute('aria-expanded', String(on));
    r.body.hidden = !on;
  });
  r.spent.addEventListener('click', function () {
    var c = aiEl && aiEl.capRows[r.id];
    aiGo('limits', null, c ? c.cap : aiEl.cap.daily_cents.input);
  });
  r.seg.owner.addEventListener('click', function () {
    if (r.seg.owner.getAttribute('aria-pressed') !== 'true') set({ mode: 'owner' });
  });
  r.seg.open.addEventListener('click', function () {
    if (r.seg.open.getAttribute('aria-pressed') !== 'true') set({ mode: 'open' });
  });
  r.model.addEventListener('change', function () {
    if (r.model.value) set({ model: r.model.value });
  });
  if (r.sw) {
    r.sw.addEventListener('click', function () { set({ enabled: !aiSwitchOn(r.sw) }); });
  }
  if (r.beyond) {
    r.beyond.addEventListener('click', function () { set({ beyond: !aiSwitchOn(r.beyond) }); });
  }
  if (r.phone) {
    r.phone.addEventListener('click', function () { set({ phone_button: !aiSwitchOn(r.phone) }); });
  }
}

/* One line under Limits for one feature's two numbers: its daily cap and today's extra. */
function aiCapRow(id) {
  var c = { id: id };
  c.li = el('li', 'aicaprow');
  c.name = el('span', 'aicapname');
  c.li.appendChild(c.name);
  c.spent = el('span', 'aispent');
  c.li.appendChild(c.spent);
  c.cap = aiTextInput();
  c.bonus = aiTextInput();
  var cw = el('span', 'aicapcell'), bw = el('span', 'aicapcell');
  cw.appendChild(c.cap);
  bw.appendChild(c.bonus);
  c.li.appendChild(cw);
  c.li.appendChild(bw);
  c.err = el('p', 'err-inline aicaperr');
  c.err.hidden = true;
  c.li.appendChild(c.err);
  c.tick = el('span', 'aisaved aicaptick');
  c.li.appendChild(c.tick);

  function clear() { c.err.hidden = true; c.err.textContent = ''; }
  function money(inp, blank) {
    var raw = inp.value.trim().replace(/^\$/, '');
    if (raw === '') return blank;
    var n = Number(raw);
    return isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  }
  [c.cap, c.bonus].forEach(function (inp) {
    inp.addEventListener('input', function () { inp.setAttribute('data-editing', '1'); });
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') inp.blur(); });
  });
  c.cap.addEventListener('change', function () {
    c.cap.removeAttribute('data-editing');
    clear();
    var cents = money(c.cap, null);
    if (cents === null) { paintAi(); return; }
    if (isNaN(cents)) { aiShowAt(c.err, 'Numbers only.'); return; }
    aiFeatureSet(id, { daily_cents: cents }, { busy: [c.cap], msg: c.err, clear: clear, errs: { daily_cents: c.err } })
      .then(function (r) { if (r && r.ok) aiTick(c.tick); });
  });
  c.bonus.addEventListener('change', function () {
    c.bonus.removeAttribute('data-editing');
    clear();
    var cents = money(c.bonus, 0);
    if (isNaN(cents)) { aiShowAt(c.err, 'Numbers only.'); return; }
    aiBonusSet(id, cents, c.err).then(function (r) {
      if (r !== null && !(r && r.ok === false)) aiTick(c.tick);
    });
  });
  return c;
}

/* ---- painting ---- */

/* Enabled models only. A feature still set to a model that has since been switched off
   shows it, marked and not selectable, so the select never claims a model that is not the
   stored one. */
function aiPaintModelSelect(sel, current) {
  current = current == null ? '' : String(current);
  sel.innerHTML = '';
  var found = false;
  aiState.models.forEach(function (m) {
    var on = m.enabled !== false;
    if (!on && m.id !== current) return;
    var o = document.createElement('option');
    o.value = m.id;
    o.textContent = (m.name || m.id) + (on ? '' : ' (off)');
    o.disabled = !on;
    if (m.id === current) found = true;
    sel.appendChild(o);
  });
  if (!found) {
    var o = document.createElement('option');
    o.value = current;
    o.textContent = current || 'no model set';
    o.disabled = true;
    sel.appendChild(o);
  }
  sel.value = current;
}

function aiPaintMode(r, mode) {
  var open = mode === 'open';
  r.seg.owner.setAttribute('aria-pressed', String(!open));
  r.seg.open.setAttribute('aria-pressed', String(open));
}

function aiPaintSaqRow(r, s) {
  var info = aiFeatureInfo('saq');
  r.name.textContent = info.label;
  r.open.setAttribute('aria-label', info.label + ', settings');
  /* Without 0011 the ledger has no feature column and every call in it is a grade. */
  var today = aiState.saq ? aiState.saq.today_cents : (aiState.usage ? aiState.usage.today_cents : 0);
  /* No cap of its own to measure against, so no bar: the figure alone, and the button goes to
     the account's daily cap, which is the one that holds it. */
  r.spentText.textContent = aiCapCents(today) + ' today';
  r.spent.classList.add('nocap');
  r.spent.setAttribute('aria-label', aiCapCents(today) + ' today. It spends against the account caps under Limits.');
  r.about.textContent = 'Marks a written short answer against the rubric. It has no switch or cap of its ' +
    'own: it runs whenever Everything Ask can do is on, against the account caps.';
  r.about.hidden = false;
  r.meta.textContent = 'tag ' + info.tag;
  r.fixed.textContent = s.enabled ? 'On with everything' : 'Off with everything';
  r.li.classList.toggle('off', !s.enabled);
  aiPaintMode(r, s.mode);
  aiPaintModelSelect(r.model, s.model);
}

function aiPaintFeatRow(r, f, s) {
  var name = String(f.name || f.id);
  var info = aiFeatureInfo(f.id);
  r.name.textContent = name;
  r.open.setAttribute('aria-label', name + ', settings');
  if (r.about) {
    r.about.textContent = info && info.about ? info.about : '';
    r.about.hidden = !(info && info.about);
  }
  r.beta.hidden = !f.beta;
  r.sw.setAttribute('aria-checked', String(!!f.enabled));
  r.sw.setAttribute('aria-label', name);
  /* The breaker's pause is the one reason a switched on feature does nothing, so the row says
     so itself rather than leaving it to be found under Limits. */
  r.paused.hidden = aiPausedNames(aiState.guards).indexOf(f.id) < 0;
  var bonus = Number(f.bonus_cents) || 0;
  r.meta.textContent = aiCount(f.today_calls, 'call') + ' today' +
    (bonus ? ' · ' + dollars(bonus) + ' extra today' : '') +
    (Number(f.codes_today_cents) > 0 ? ' · codes ' + spendDollars(f.codes_today_cents) + ' from their own money' : '') +
    ' · tag ' + String(f.tag || '');
  r.li.classList.toggle('off', !s.enabled || !f.enabled);
  aiPaintMode(r, f.mode);
  aiPaintModelSelect(r.model, f.model);
  /* Pulling a link runs no model at all, so a model select on its row would be a control that
     controls nothing. */
  r.modelField.hidden = !!(info && info.nomodel);
  if (r.beyond) {
    /* The Ask row alone. Since 0036 every answer in a material reads that one switch, whichever
       row the call was billed to, and a research answer never goes past its sources at all. */
    r.beyondField.hidden = typeof f.beyond !== 'boolean' || f.id !== 'ask';
    r.beyond.setAttribute('aria-checked', String(!!f.beyond));
  }
  if (r.phone) {
    r.phoneField.hidden = typeof f.phone_button !== 'boolean' || f.id !== 'ask';
    r.phone.setAttribute('aria-checked', String(!!f.phone_button));
  }
  aiPaintSpent(r, f.today_cents, f.daily_cents, bonus);
}

/* One feature's spend against its own ceiling, in cents, because that is the unit these caps are
   felt in and a fraction of a cent written in dollars is four zeroes and a guess. */
function aiSpentText(todayCents, capCents, bonusCents) {
  var spent = Number(todayCents) || 0;
  var cap = (Number(capCents) || 0) + (Number(bonusCents) || 0);
  var share = cap > 0 ? spent / cap : (spent > 0 ? 1 : 0);
  return { share: share, cap: cap,
    text: aiCapCents(spent) + ' of ' + aiCapCents(cap),
    tone: share >= 1 ? 'full' : share >= 0.85 ? 'near' : '' };
}

function aiPaintSpent(r, todayCents, capCents, bonusCents) {
  var t = aiSpentText(todayCents, capCents, bonusCents);
  r.spentText.textContent = t.text;
  r.spentFill.style.width = Math.max(0, Math.min(100, t.share * 100)).toFixed(1) + '%';
  r.spent.classList.toggle('near', t.tone === 'near');
  r.spent.classList.toggle('full', t.tone === 'full');
  r.spent.setAttribute('aria-label', t.text + ' today' +
    (t.tone === 'full' ? ', full until tomorrow' : '') + '. Change the cap under Limits.');
}

function aiPaintCapRow(c, f) {
  var bonus = Number(f.bonus_cents) || 0;
  c.name.textContent = String(f.name || f.id);
  c.cap.setAttribute('aria-label', 'Daily cap for ' + c.name.textContent + ', dollars');
  c.bonus.setAttribute('aria-label', 'Extra today for ' + c.name.textContent + ', dollars');
  var t = aiSpentText(f.today_cents, f.daily_cents, bonus);
  c.spent.textContent = t.text + (t.tone === 'full' ? ', full' : '');
  c.spent.classList.toggle('near', t.tone === 'near');
  c.spent.classList.toggle('full', t.tone === 'full');
  c.li.classList.toggle('off', !f.enabled);
  if (c.cap.getAttribute('data-editing') !== '1') {
    c.cap.value = f.daily_cents == null ? '' : (Number(f.daily_cents) / 100).toFixed(2);
  }
  if (c.bonus.getAttribute('data-editing') !== '1') {
    c.bonus.value = bonus ? (bonus / 100).toFixed(2) : '';
  }
}

/* A cap figure in cents, to as few places as say something true. Deliberately not aiCents, which
   is further down this file and takes microcents: two function declarations of one name in this
   scope would leave whichever is written last answering for both. */
function aiCapCents(n) {
  var v = Number(n) || 0;
  if (v <= 0) return '0c';
  return (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/0$/, '')) + 'c';
}

/* Which group a feature's row sits under. One the panel has never heard of goes under Other
   rather than vanishing, since the server's list is the truth about what exists. */
function aiGroupOf(id) {
  var hit = 'other';
  AI_FEATURE_GROUPS.forEach(function (g) { if (g.ids.indexOf(id) >= 0) hit = g.id; });
  return hit;
}

function aiPaintFeatures() {
  var s = aiState.settings;
  var list = [{ id: 'saq' }].concat((aiState.features || []).filter(function (f) {
    return f && typeof f.id === 'string' && f.id !== 'saq';
  }));
  var keep = Object.create(null);
  var byGroup = Object.create(null);
  list.forEach(function (f) {
    keep[f.id] = true;
    var r = aiEl.rows[f.id] || (aiEl.rows[f.id] = aiFeatRow(f.id));
    var gid = aiGroupOf(f.id);
    (byGroup[gid] || (byGroup[gid] = [])).push({ f: f, r: r });
    if (r.saq) aiPaintSaqRow(r, s); else aiPaintFeatRow(r, f, s);
  });
  AI_FEATURE_GROUPS.forEach(function (g) {
    var box = aiEl.groups[g.id], rows = byGroup[g.id] || [];
    /* In the order the group names them, then anything else as the server sent it. */
    rows.sort(function (a, b) {
      var ia = g.ids.indexOf(a.f.id), ib = g.ids.indexOf(b.f.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    rows.forEach(function (x, i) {
      /* Moving a node that holds focus blurs it, so a row is only moved when it is out of place. */
      if (box.list.children[i] !== x.r.li) box.list.insertBefore(x.r.li, box.list.children[i] || null);
    });
    box.wrap.hidden = !rows.length;
    var on = rows.filter(function (x) { return x.r.saq ? s.enabled : x.f.enabled; }).length;
    box.count.textContent = rows.length ? on + ' of ' + rows.length + ' on' : '';
  });
  Object.keys(aiEl.rows).forEach(function (id) {
    if (keep[id]) return;
    var gone = aiEl.rows[id];
    if (gone.li.parentNode) gone.li.parentNode.removeChild(gone.li);
    delete aiEl.rows[id];
  });

  /* The same features again under Limits, one line each, for their caps. */
  var capKeep = Object.create(null), n = 0;
  AI_FEATURE_GROUPS.forEach(function (g) {
    (byGroup[g.id] || []).forEach(function (x) {
      if (x.r.saq) return;
      capKeep[x.f.id] = true;
      var c = aiEl.capRows[x.f.id] || (aiEl.capRows[x.f.id] = aiCapRow(x.f.id));
      if (aiEl.capList.children[n] !== c.li) aiEl.capList.insertBefore(c.li, aiEl.capList.children[n] || null);
      n++;
      aiPaintCapRow(c, x.f);
    });
  });
  Object.keys(aiEl.capRows).forEach(function (id) {
    if (capKeep[id]) return;
    var gone = aiEl.capRows[id];
    if (gone.li.parentNode) gone.li.parentNode.removeChild(gone.li);
    delete aiEl.capRows[id];
  });

  aiEl.held.hidden = !!s.enabled;
  aiEl.featNote.textContent = aiState.featErr || '';
  aiEl.featNote.hidden = !aiState.featErr;
}

function aiPaintModels() {
  aiEl.models.innerHTML = '';
  var used = aiModelsInUse();
  aiState.models.forEach(function (m) {
    var row = el('div', 'aimodel' + (used[m.id] ? ' on' : ''));
    row.appendChild(el('span', 'aimodelid', m.id));
    row.appendChild(el('span', 'aimodelmeta', aiModelMeta(m)));
    aiEl.models.appendChild(row);
  });
  aiEl.models.hidden = !aiState.models.length;
}

/* What an extra is worth today. The server works that out (it knows where the day starts, and
   whether the spend was reset), and the panel prints what it is told. Reading a date off this
   device would be wrong twice over: a wrong clock, and no idea about a reset. */
function aiBonusToday(row) {
  return row ? (Number(row.bonus_today_cents) || 0) : 0;
}

/* The strip at the top: the two meters, the codes line, and whatever needs the owner. This is
   what used to be spread over Spend's readout, the closed line of three folds and the inside of
   Guards. Each thing that needs attention comes with the button that deals with it, because a
   warning that has to be carried to another screen to be acted on is half a warning. */
function aiNearestCap() {
  var tight = null, worst = -1, tightCap = 0;
  (aiState.features || []).forEach(function (f) {
    if (!f || !f.enabled || f.id === 'saq') return;
    var cap = (Number(f.daily_cents) || 0) + (Number(f.bonus_cents) || 0);
    if (!isFinite(cap) || cap <= 0) return;
    var share = (Number(f.today_cents) || 0) / cap;
    if (share > worst) { worst = share; tight = f; tightCap = cap; }
  });
  return tight ? { f: tight, share: worst, cap: tightCap } : null;
}

function aiAttnItem(tone, text, actions) {
  var li = el('li', 'aiattnitem' + (tone ? ' ' + tone : ''));
  li.appendChild(el('span', 'aiattntext', text));
  var row = el('span', 'aiattnacts');
  (actions || []).forEach(function (a) {
    var b = el('button', 'btn ghost sm', a.label);
    b.type = 'button';
    b.addEventListener('click', function () {
      var p = a.run(b);
      if (p && p.then) { b.disabled = true; p.then(function () { b.disabled = false; }, function () { b.disabled = false; }); }
    });
    row.appendChild(b);
  });
  if (row.firstChild) li.appendChild(row);
  return li;
}

function aiPaintHead() {
  if (!aiEl || !aiEl.attn) return;
  var e = aiEl, u = aiState.usage, s = aiState.settings, g = aiState.guards;
  var bonus = aiBonusToday(s);
  var dayCap = (s ? Number(s.daily_cents) || 0 : 0) + bonus;
  var monthCap = s ? Number(s.monthly_cents) || 0 : 0;
  if (!u) {
    var waiting = aiState.usageErr ? 'could not load' : 'loading';
    aiMeterPaint(e.meterDay, 0, dayCap, waiting);
    aiMeterPaint(e.meterMonth, 0, monthCap, waiting);
    e.codesLine.hidden = true;
  } else {
    aiMeterPaint(e.meterDay, u.today_cents, dayCap,
      shortDollars(u.today_cents) + ' of ' + dollars(dayCap) + (bonus ? ' (' + dollars(bonus) + ' extra)' : '') +
      ' · ' + aiCount(u.today_calls, 'call'));
    aiMeterPaint(e.meterMonth, u.month_cents, monthCap,
      shortDollars(u.month_cents) + ' of ' + dollars(monthCap) + ' · ' + aiCount(u.month_calls, 'call'));
    /* What codes spent comes off the money loaded on them, never counts against the caps above
       and is never stopped by them (0026), so it is a line of its own and not part of a meter. */
    var codes = Number(u.codes_month_cents) > 0 || Number(u.codes_today_cents) > 0;
    e.codesLine.hidden = !codes;
    if (codes) {
      e.codesLine.textContent = 'Codes, from their own money: today ' + shortDollars(u.codes_today_cents) +
        ', month ' + shortDollars(u.codes_month_cents) + '. Not counted above.';
    }
  }

  var items = [];
  if (s && !s.enabled) {
    items.push(aiAttnItem('warn', 'Everything Ask can do is off, so nothing can run.'));
  }
  if (u && s) {
    var dayShare = dayCap > 0 ? Number(u.today_cents) / dayCap : 0;
    if (dayShare >= 0.85) {
      items.push(aiAttnItem(dayShare >= 1 ? 'bad' : 'warn',
        dayShare >= 1 ? 'Today\'s cap is reached. Every feature refuses until tomorrow.'
          : 'Today\'s cap is nearly reached: ' + aiCapCents(dayCap - Number(u.today_cents)) + ' left.',
        [{ label: 'Add $0.50 today', run: function () { return aiBonusSet(null, bonus + 50, e.masterErr); } },
         { label: 'Limits', run: function () { aiGo('limits', null, e.cap.daily_cents.input); } }]));
    }
    var monthShare = monthCap > 0 ? Number(u.month_cents) / monthCap : 0;
    if (monthShare >= 0.85) {
      items.push(aiAttnItem(monthShare >= 1 ? 'bad' : 'warn',
        monthShare >= 1 ? 'This month\'s cap is reached. Every feature refuses until it is raised or the month turns.'
          : 'This month\'s cap is nearly reached: ' + aiCapCents(monthCap - Number(u.month_cents)) + ' left.',
        [{ label: 'Limits', run: function () { aiGo('limits', null, e.cap.monthly_cents.input); } }]));
    }
  }
  /* A feature at its own ceiling refuses an answer while the meters above still look healthy,
     and read alone that looks like a bug in the hub rather than a limit working. */
  (aiState.features || []).forEach(function (f) {
    if (!f || !f.enabled || f.id === 'saq') return;
    var fb = Number(f.bonus_cents) || 0;
    var t = aiSpentText(f.today_cents, f.daily_cents, fb);
    if (t.cap <= 0 || t.share < 0.85) return;
    var nm = String(f.name || f.id);
    items.push(aiAttnItem(t.share >= 1 ? 'bad' : 'warn',
      t.share >= 1 ? nm + ' is at its own daily cap (' + t.text + ') and refuses until tomorrow.'
        : nm + ' is near its own daily cap: ' + t.text + '.',
      [{ label: 'Add 25c today', run: function () { return aiBonusSet(f.id, fb + 25, e.masterErr); } },
       { label: 'Its cap', run: function () { var c = e.capRows[f.id]; aiGo('limits', null, c ? c.cap : null); } }]));
  });
  var paused = aiPausedNames(g);
  if (paused.length) {
    var why = g && typeof g.note === 'string' ? g.note.trim() : '';
    items.push(aiAttnItem('warn',
      'The breaker has paused ' + paused.map(function (id) {
        var info = aiFeatureInfo(id); return info ? info.label : id;
      }).join(', ') + (why ? ': ' + why + '.' : '.'),
      [{ label: 'Clear the pause', run: function () { return aiGuardSet('reset', null, null, e.masterErr, []); } },
       { label: 'Breaker', run: function () { aiGo('limits', null, e.guardBreaker); } }]));
  }
  var fs = aiState.flagStats, ts = aiState.ticketStats;
  var openFlags = fs ? Number(fs.open) || 0 : 0;
  var openTickets = ts ? Number(ts.open) || 0 : 0;
  if (openFlags) {
    items.push(aiAttnItem('', aiCount(openFlags, 'flagged sentence') + ' to read.',
      [{ label: 'Review', run: function () { aiGo('activity', e.flagGroup); } }]));
  }
  if (openTickets) {
    items.push(aiAttnItem('', aiCount(openTickets, 'open report') + '.',
      [{ label: 'Read', run: function () { aiGo('people', e.ticketGroup); } }]));
  }
  e.tabs.badge('activity', openFlags);
  e.tabs.badge('people', openTickets);
  var near = aiNearestCap();
  e.tabs.badge('limits', (near && near.share >= 0.85 ? 1 : 0) + (paused.length ? 1 : 0));

  e.attn.innerHTML = '';
  if (!items.length) items.push(el('li', 'aiattnitem quiet', s && s.enabled ? 'Nothing needs you.' : ''));
  items.forEach(function (li) { if (li.textContent) e.attn.appendChild(li); });
}

function aiPaintReadout() {
  var bonus = aiBonusToday(aiState.settings);
  if (aiEl.bonus && aiEl.bonus.getAttribute('data-editing') !== '1') {
    aiEl.bonus.value = bonus ? (bonus / 100).toFixed(2) : '';
  }
  aiPaintHead();
}

function aiPaintCalls() {
  var u = aiState.usage;
  aiEl.calls.innerHTML = '';
  var calls = (u && Array.isArray(u.recent)) ? u.recent.slice(0, 20) : [];
  if (!calls.length) { aiEl.calls.appendChild(el('p', 'note', 'No calls yet.')); return; }

  /* The ledger has a feature column from 0011 on; the readout only prints it once the
     usage call actually returns it. */
  var withFeature = calls.some(function (c) { return c && c.feature != null; });
  var t = el('table', 'aitable');
  var head = document.createElement('tr');
  var withWho = calls.some(function (c) { return c && c.who != null; });
  ['Time'].concat(withWho ? ['Who'] : [], withFeature ? ['Feature'] : [], ['Material', 'Model', 'Cost', 'Status']).forEach(function (h) {
    head.appendChild(el('th', null, h));
  });
  t.appendChild(head);
  calls.forEach(function (c) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', null, aiWhen(c.created_at)));
    if (withWho) {
      tr.appendChild(el('td', null, c.who === 'pass' ? 'Code ' + (c.pass_label || '#' + c.pass_id)
        : c.who === 'owner' ? 'You' : c.who === 'open' ? 'Visitor' : ''));
    }
    if (withFeature) {
      var info = aiFeatureInfo(c.feature);
      tr.appendChild(el('td', null, info ? info.short : String(c.feature || '')));
    }
    tr.appendChild(el('td', null, c.material || ''));
    tr.appendChild(el('td', null, c.model || ''));
    tr.appendChild(el('td', null, microDollars(c.cost_microcents)));
    tr.appendChild(el('td', c.status === 'ok' ? null : 'aibad', c.status || ''));
    t.appendChild(tr);
  });
  aiEl.calls.appendChild(t);
}

/* What each closed fold says about itself. */
function aiPaintSummaries() {
  var u = aiState.usage;
  var ms = aiState.models, s = aiState.settings;
  aiEl.modelsGroup.state.textContent = (s && s.effort ? 'effort ' + s.effort + ' · ' : '') + (ms.length
    ? ms.length + ' listed · ' + ms.filter(function (m) { return m.enabled !== false; }).length + ' on'
    : 'none listed');
  var calls = (u && Array.isArray(u.recent)) ? u.recent : [];
  aiEl.callsGroup.state.textContent = calls.length ? 'last ' + aiWhen(calls[0].created_at) : 'none yet';
}

function paintAi() {
  if (!aiEl) return;
  var s = aiState.settings;
  if (!s) return;

  aiEl.master.setAttribute('aria-checked', String(!!s.enabled));
  AI_FIELDS.forEach(function (f) {
    var inp = aiEl.cap[f.key].input;
    if (inp.getAttribute('data-editing') === '1') return;
    var v = s[f.key];
    inp.value = v == null ? '' : (f.money ? (Number(v) / 100).toFixed(2) : String(v));
  });
  aiEl.effort.value = s.effort || 'low';
  aiEl.effortHint.hidden = !aiUsesHaiku();

  aiPaintFeatures();
  aiPaintModels();
  aiPaintReadout();
  aiPaintSummaries();
}

function paintAiUsage() {
  if (!aiEl) return;
  aiPaintReadout();
  aiPaintCalls();
  if (aiState.settings) aiPaintFeatures();
  aiPaintSummaries();
}

/* ---- saving and loading ---- */

/* Writes through admin_ai_set: the master switch, the caps, effort, and SAQ grading's mode
   and model. row is SAQ grading's row when the write came from it; els are the controls to
   hold still until the server answers. */
function aiSet(patch, row, els) {
  if (!aiEl) return Promise.resolve(null);
  var busy = (els || []).concat(row ? aiRowControls(row) : []);
  aiNote('');
  aiClearFieldErrors();
  if (row) aiRowClear(row);
  aiDisable(busy, true);
  return StudyAuth.admin.ai.set(patch).then(function (r) {
    aiDisable(busy, false);
    if (r && r.ok && r.settings) { aiState.settings = r.settings; paintAi(); return r; }
    if (r && r.ok) return aiLoadSettings().then(function () { return r; });
    aiShowError(r, row);
    /* A refused write must not leave the controls showing what was asked for rather than
       what is stored, so the stored row is painted back over the attempt. */
    paintAi();
    return r;
  }, function (err) {
    aiDisable(busy, false);
    if (row) aiShowAt(row.msg, aiErrText(err)); else aiNote(aiErrText(err));
    paintAi();
    return null;
  });
}

/* Today's extra budget, for one feature or (feature null) the global daily cap. The reply
   carries the new ceiling and what has been spent against it, and the panel reloads so every
   readout agrees. */
function aiBonusSet(feature, cents, errAt, row) {
  if (!aiEl) return Promise.resolve(null);
  return StudyAuth.admin.ai.bonus(feature, cents).then(function (r) {
    if (r && r.ok) return aiLoad();
    aiShowAt(errAt, r && r.error === 'range' ? 'The server refused that: $0 to $100.' : aiRefusal(r));
    return r;
  }, function (err) {
    aiShowAt(errAt, aiErrText(err));
    return null;
  });
}

/* Writes one feature through admin_ai_feature_set. The reply is the stored row, which is
   merged over the one in hand so today's spend (not part of the reply) stays put. ctx says
   which controls to hold still and where a refusal is printed: a feature's row for its switch,
   mode and model, its line under Limits for its cap. */
function aiFeatureSet(id, patch, ctx) {
  if (!aiEl) return Promise.resolve(null);
  var busy = ctx.busy || [];
  var body = { id: id };
  Object.keys(patch).forEach(function (k) { body[k] = patch[k]; });
  if (ctx.clear) ctx.clear();
  aiDisable(busy, true);
  return StudyAuth.admin.ai.featureSet(body).then(function (r) {
    aiDisable(busy, false);
    if (r && r.ok && r.feature) { aiMergeFeature(r.feature); paintAi(); return r; }
    if (r && r.ok) return aiLoad().then(function () { return r; });
    var field = r && r.error === 'range' ? r.field : null;
    var at = (field && ctx.errs && ctx.errs[field]) || ctx.msg;
    aiShowAt(at, field ? aiRangeText(field) : aiRefusal(r));
    paintAi();
    return r;
  }, function (err) {
    aiDisable(busy, false);
    aiShowAt(ctx.msg, aiErrText(err));
    paintAi();
    return null;
  });
}

function aiMergeFeature(f) {
  if (!f || typeof f.id !== 'string') return;
  var list = aiState.features || (aiState.features = []);
  var cur = null;
  list.forEach(function (x) { if (x && x.id === f.id) cur = x; });
  if (!cur) { list.push(f); return; }
  /* Not bonus_cents. The reply is the raw row, and the raw column still holds yesterday's extra
     until it is next written; only the list call knows whether it counts today. Merging it made
     any save on a row bring a lapsed extra back onto the screen and into that row's ceiling. */
  ['name', 'enabled', 'mode', 'model', 'daily_cents', 'tag', 'beta', 'beyond', 'phone_button', 'updated_at'].forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(f, k)) cur[k] = f[k];
  });
}

function aiLoadSettings() {
  return StudyAuth.admin.ai.settings().then(function (r) {
    if (!r || !r.ok) { aiShowError(r); return null; }
    aiState.settings = r.settings || null;
    paintAi();
    return r;
  });
}

/* admin_ai_usage answers with the numbers at the top level of the payload, so the payload
   itself is the readout's state. A failure is said only in the readout: the ledger not
   loading is no reason to make the switches above look broken, and "nothing spent" would be
   a wrong thing to print in its place. */
function aiLoadUsage() {
  return StudyAuth.admin.ai.usage().then(function (r) {
    if (r && r.ok) { aiState.usage = r; aiState.usageErr = false; }
    else aiState.usageErr = true;
    paintAiUsage();
  }, function () { aiState.usageErr = true; paintAiUsage(); });
}

/* ---- reports ---- */

var TICKET_KIND = { material: 'In the material', answer: 'An answer', app: 'Broken or wrong', other: 'Other' };

function aiTicketRow(t) {
  var li = el('li', 'aiticket' + (t.status === 'open' ? '' : ' done'));
  var head = el('div', 'aitickethead');
  var who = el('div', 'aiticketwho');
  var title = el('div', 'aipasstitle');
  title.appendChild(el('span', 'aipassname', t.summary || ''));
  title.appendChild(el('span', 'aipassstate' + (t.status === 'open' ? ' on' : ''), t.status));
  who.appendChild(title);
  who.appendChild(el('p', 'aifeatmeta',
    (TICKET_KIND[t.kind] || t.kind) + ' · ' + (t.material || 'the hub') + ' · ' + t.by_role + ' · ' + aiWhen(t.created_at)));
  head.appendChild(who);
  li.appendChild(head);
  if (t.body) li.appendChild(el('p', 'aiticketbody', t.body));
  var ctx = t.context && typeof t.context === 'object' ? t.context : null;
  if (ctx) {
    var bits = [];
    ['tab', 'screen', 'question', 'answer', 'card', 'chat_id'].forEach(function (k) {
      if (ctx[k]) bits.push(k + ': ' + String(ctx[k]).slice(0, 220));
    });
    if (bits.length) li.appendChild(el('p', 'aiticketctx', bits.join(' · ')));
  }
  var ctl = el('div', 'row wrap aipassctl');
  var err = el('p', 'err-inline');
  err.hidden = true;
  function act(text, status) {
    var b = el('button', 'btn sm out', text);
    b.type = 'button';
    b.addEventListener('click', function () {
      StudyAuth.admin.ai.ticketSet(t.id, status, null).then(function (r) {
        if (r && r.ok) return aiLoadTickets();
        aiShowAt(err, aiRefusal(r));
      }, function (e2) { aiShowAt(err, aiErrText(e2)); });
    });
    ctl.appendChild(b);
  }
  if (t.status !== 'fixed') act('Fixed', 'fixed');
  if (t.status !== 'wontfix') act('Leave it', 'wontfix');
  if (t.status !== 'open') act('Reopen', 'open');
  var del = el('button', 'btn sm out', 'Delete');
  del.type = 'button';
  del.addEventListener('click', function () {
    if (!window.confirm('Delete this report?')) return;
    StudyAuth.admin.ai.ticketDelete(t.id).then(function (r) {
      if (r && r.ok) return aiLoadTickets();
      aiShowAt(err, aiRefusal(r));
    }, function (e2) { aiShowAt(err, aiErrText(e2)); });
  });
  ctl.appendChild(del);
  li.appendChild(ctl);
  li.appendChild(err);
  return li;
}

function aiPaintTickets() {
  if (!aiEl || !aiEl.ticketList) return;
  aiEl.ticketList.innerHTML = '';
  (aiState.tickets || []).forEach(function (t) { aiEl.ticketList.appendChild(aiTicketRow(t)); });
  if (!(aiState.tickets || []).length) {
    aiEl.ticketList.appendChild(el('li', 'note', aiState.ticketOpenOnly ? 'Nothing open.' : 'No reports yet.'));
  }
  aiEl.ticketNote.textContent = aiState.ticketErr || '';
  aiEl.ticketNote.hidden = !aiState.ticketErr;
  var st = aiState.ticketStats;
  aiEl.ticketGroup.state.textContent = st
    ? (Number(st.open) || 0) + ' open · ' + (Number(st.total) || 0) + ' all told'
    : 'none yet';
  aiPaintHead();
}

function aiLoadTickets() {
  if (!aiEl) return Promise.resolve();
  return StudyAuth.admin.ai.tickets(aiState.ticketOpenOnly ? 'open' : null, 40, null).then(function (r) {
    if (!aiEl) return;
    if (!r || !r.ok) {
      aiState.tickets = [];
      aiState.ticketErr = r && r.error === 'forbidden' ? 'That admin session was refused. Sign in again.'
        : 'Run 0018_tickets.sql in Supabase to collect reports.';
      aiPaintTickets();
      return;
    }
    aiState.tickets = Array.isArray(r.tickets) ? r.tickets : [];
    aiState.ticketStats = r.stats || null;
    aiState.ticketErr = '';
    aiPaintTickets();
  }, function () {
    if (!aiEl) return;
    aiState.tickets = [];
    aiState.ticketErr = 'Run 0018_tickets.sql in Supabase to collect reports.';
    aiPaintTickets();
  });
}

/* ---- flags, corrections and guards (0033) ---- */

/* None of these RPCs is on the database until 0033 is applied, so each group says so inside
   itself and the rest of the panel carries on working. A refusal is named for what it is; a
   404, a throw, or anything else reads as the migration not being there yet. */
function ai33Err(r, err) {
  if (r && r.error === 'forbidden') return 'That admin session was refused. Sign in again.';
  if (err && err.message === 'rate_limited') return 'Too many tries from this network. Wait a few minutes.';
  return 'Run 0033_flags_corrections_guards.sql in Supabase to turn this on.';
}

/* One flag: what the check was, the sentence it caught, where it came from, and the question
   that produced it. The form that turns it into a correction is built closed. */
function aiFlagRow(f) {
  var li = el('li', 'aiticket' + (f.reviewed ? ' done' : ''));
  var head = el('div', 'aitickethead');
  var who = el('div', 'aiticketwho');
  var title = el('div', 'aipasstitle');
  title.appendChild(el('span', 'aipassname', String(f.kind || 'a check')));
  title.appendChild(el('span', 'aipassstate' + (f.reviewed ? '' : ' on'), f.reviewed ? 'reviewed' : 'open'));
  who.appendChild(title);
  var bits = [f.material ? String(f.material) : 'no material'];
  if (f.route) bits.push(String(f.route));
  if (f.chat_id != null) bits.push('chat ' + Number(f.chat_id));
  if (aiWhen(f.created_at)) bits.push(aiWhen(f.created_at));
  who.appendChild(el('p', 'aifeatmeta', bits.join(' · ')));
  head.appendChild(who);
  li.appendChild(head);

  li.appendChild(el('p', 'lbl', 'The sentence'));
  li.appendChild(el('p', 'aiticketbody', f.sentence ? String(f.sentence) : 'Nothing was kept.'));
  if (f.question) {
    li.appendChild(el('p', 'lbl', 'The question'));
    li.appendChild(el('p', 'aiticketctx', String(f.question)));
  }

  var err = el('p', 'err-inline');
  err.hidden = true;

  var form = el('div', 'aifix');
  form.hidden = true;
  var topic = aiWordsInput(1);
  form.appendChild(aiField('aifixf', 'Topic', topic).field);
  form.appendChild(el('p', 'aimeta',
    'The words a question has to contain for this correction to be sent. Words of three ' +
    'letters or fewer are ignored, so a topic of only short words is never matched.'));
  var body = aiWordsInput(3);
  form.appendChild(aiField('aifixf', 'What is true', body).field);
  var frow = el('div', 'row wrap');
  var save = el('button', 'btn sm', 'Save the correction');
  save.type = 'button';
  var shut = el('button', 'btn sm out', 'Cancel');
  shut.type = 'button';
  frow.appendChild(save);
  frow.appendChild(shut);
  form.appendChild(frow);

  var ctl = el('div', 'row wrap aipassctl');
  var open = el('button', 'btn sm out', 'Correct this');
  open.type = 'button';
  open.setAttribute('aria-expanded', 'false');
  open.addEventListener('click', function () {
    var on = form.hidden;
    form.hidden = !on;
    open.setAttribute('aria-expanded', String(on));
    err.hidden = true;
    if (on) { try { topic.focus(); } catch (e) {} }
  });
  ctl.appendChild(open);
  if (!f.reviewed) {
    var done = el('button', 'btn sm out', 'Not a problem');
    done.type = 'button';
    done.addEventListener('click', function () {
      err.hidden = true;
      aiDisable([done], true);
      StudyAuth.admin.ai.flagReviewed(f.id).then(function (r) {
        aiDisable([done], false);
        /* The server answers ok whether or not a row matched, so the list is read again rather
           than this row being struck out on trust. */
        if (r && r.ok) return aiLoadFlags();
        aiShowAt(err, ai33Err(r, null));
      }, function (e2) { aiDisable([done], false); aiShowAt(err, aiErrText(e2)); });
    });
    ctl.appendChild(done);
  }
  li.appendChild(ctl);
  li.appendChild(form);
  li.appendChild(err);

  save.addEventListener('click', function () {
    err.hidden = true;
    /* The material comes from the flag itself. Without one the insert cannot happen and the
       server answers with a generic refusal, so it is said here instead. */
    if (!f.material) {
      aiShowAt(err, 'This flag kept no material, so a correction cannot be filed from it.');
      return;
    }
    var t = topic.value.trim(), b = body.value.trim();
    if (!t) { aiShowAt(err, 'Give it a topic.'); return; }
    if (!b) { aiShowAt(err, 'Write what is true.'); return; }
    aiDisable([save, shut], true);
    StudyAuth.admin.ai.correctionAdd(f.material, t, b, f.id).then(function (r) {
      aiDisable([save, shut], false);
      if (r && r.ok) {
        /* Filing it marks the flag reviewed in the same call, so both lists are read again. */
        aiLoadCorrections();
        return aiLoadFlags();
      }
      aiShowAt(err, r && r.error === 'bad_row'
        ? 'The server wants both a topic and something true to say.'
        : ai33Err(r, null));
    }, function (e2) { aiDisable([save, shut], false); aiShowAt(err, aiErrText(e2)); });
  });
  shut.addEventListener('click', function () {
    form.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    err.hidden = true;
  });
  return li;
}

/* total and open are counted over the flags themselves; by_kind counts only the open ones, so
   it is labelled as such rather than left to be added up against total. */
function aiFlagStatsText(st) {
  if (!st) return '';
  var out = Number(st.open || 0) + ' open of ' + Number(st.total || 0) + ' ever seen';
  var by = st.by_kind && typeof st.by_kind === 'object' ? st.by_kind : null;
  var kinds = by ? Object.keys(by) : [];
  if (kinds.length) {
    kinds.sort(function (a, b) { return Number(by[b]) - Number(by[a]); });
    out += ' · open by kind: ' + kinds.map(function (k) {
      return k + ' ' + Number(by[k]);
    }).join(', ');
  }
  return out;
}

function aiPaintFlags() {
  if (!aiEl || !aiEl.flagList) return;
  aiEl.flagList.innerHTML = '';
  (aiState.flags || []).forEach(function (f) { aiEl.flagList.appendChild(aiFlagRow(f)); });
  if (!(aiState.flags || []).length && !aiState.flagErr) {
    aiEl.flagList.appendChild(el('li', 'note',
      aiState.flagAll ? 'No flags yet.' : 'Nothing open.'));
  }
  aiEl.flagStats.textContent = aiFlagStatsText(aiState.flagStats);
  aiEl.flagNote.textContent = aiState.flagErr || '';
  aiEl.flagNote.hidden = !aiState.flagErr;
  var st = aiState.flagStats;
  aiEl.flagGroup.state.textContent = aiState.flagErr ? 'unavailable'
    : st ? Number(st.open || 0) + ' open · ' + Number(st.total || 0) + ' all told'
    : 'none yet';
  aiPaintHead();
}

function aiLoadFlags() {
  if (!aiEl) return Promise.resolve();
  return StudyAuth.admin.ai.flags(aiState.flagLimit, aiState.flagAll).then(function (r) {
    if (!aiEl) return;
    if (!r || !r.ok) {
      aiState.flags = [];
      aiState.flagStats = null;
      aiState.flagErr = ai33Err(r, null);
      aiPaintFlags();
      return;
    }
    aiState.flags = (Array.isArray(r.flags) ? r.flags : []).filter(function (f) {
      return f && typeof f === 'object' && f.id != null;
    });
    aiState.flagStats = r.stats && typeof r.stats === 'object' ? r.stats : null;
    aiState.flagErr = '';
    aiPaintFlags();
  }, function (err) {
    if (!aiEl) return;
    aiState.flags = [];
    aiState.flagStats = null;
    aiState.flagErr = ai33Err(null, err);
    aiPaintFlags();
  });
}

/* One correction: its topic, what it says, and a switch. Off is as far as it goes, so there is
   no delete here and none on the server either. */
function aiCorrRow(c) {
  var li = el('li', 'aiticket' + (c.enabled ? '' : ' done'));
  var head = el('div', 'aitickethead');
  var who = el('div', 'aiticketwho');
  var title = el('div', 'aipasstitle');
  title.appendChild(el('span', 'aipassname', String(c.topic || 'no topic')));
  title.appendChild(el('span', 'aipassstate' + (c.enabled ? ' on' : ''), c.enabled ? 'sent' : 'off'));
  who.appendChild(title);
  var bits = [c.material ? String(c.material) : 'no material'];
  if (c.from_flag != null) bits.push('from flag ' + Number(c.from_flag));
  if (aiWhen(c.created_at)) bits.push(aiWhen(c.created_at));
  who.appendChild(el('p', 'aifeatmeta', bits.join(' · ')));
  head.appendChild(who);
  var sw = aiSwitch('Send this correction');
  sw.setAttribute('aria-checked', String(!!c.enabled));
  head.appendChild(sw);
  li.appendChild(head);

  var err = el('p', 'err-inline');
  err.hidden = true;

  var body = aiWordsInput(3);
  body.value = c.body == null ? '' : String(c.body);
  li.appendChild(aiField('aifixf', 'What is true', body).field);
  var ctl = el('div', 'row wrap aipassctl');
  var save = el('button', 'btn sm out', 'Save the wording');
  save.type = 'button';
  ctl.appendChild(save);
  li.appendChild(ctl);
  li.appendChild(err);

  function write(enabled, text, els) {
    err.hidden = true;
    aiDisable(els, true);
    StudyAuth.admin.ai.correctionSet(c.id, enabled, text).then(function (r) {
      aiDisable(els, false);
      if (r && r.ok) return aiLoadCorrections();
      aiShowAt(err, ai33Err(r, null));
    }, function (e2) { aiDisable(els, false); aiShowAt(err, aiErrText(e2)); });
  }
  sw.addEventListener('click', function () { write(!aiSwitchOn(sw), null, [sw, save]); });
  save.addEventListener('click', function () {
    var text = body.value.trim();
    /* An empty body leaves the stored one alone on the server, which would look like a save
       that did nothing, so it is refused here. */
    if (!text) { aiShowAt(err, 'Write what is true, or leave the wording as it is.'); return; }
    write(null, text, [sw, save]);
  });
  return li;
}

function aiPaintCorrections() {
  if (!aiEl || !aiEl.corrList) return;
  aiEl.corrList.innerHTML = '';
  var list = aiState.corrections || [];
  list.forEach(function (c) { aiEl.corrList.appendChild(aiCorrRow(c)); });
  if (!list.length && !aiState.corrErr) {
    aiEl.corrList.appendChild(el('li', 'note', 'No corrections yet.'));
  }
  aiEl.corrNote.textContent = aiState.corrErr || '';
  aiEl.corrNote.hidden = !aiState.corrErr;
  var on = list.filter(function (c) { return c && c.enabled; }).length;
  aiEl.corrGroup.state.textContent = aiState.corrErr ? 'unavailable'
    : list.length ? aiCount(list.length, 'correction') + ' · ' + on + ' sent'
    : 'none yet';
}

function aiLoadCorrections() {
  if (!aiEl) return Promise.resolve();
  return StudyAuth.admin.ai.corrections().then(function (r) {
    if (!aiEl) return;
    if (!r || !r.ok) {
      aiState.corrections = [];
      aiState.corrErr = ai33Err(r, null);
      aiPaintCorrections();
      return;
    }
    aiState.corrections = (Array.isArray(r.corrections) ? r.corrections : []).filter(function (c) {
      return c && typeof c === 'object' && c.id != null;
    });
    aiState.corrErr = '';
    aiPaintCorrections();
  }, function (err) {
    if (!aiEl) return;
    aiState.corrections = [];
    aiState.corrErr = ai33Err(null, err);
    aiPaintCorrections();
  });
}

/* A stored guard, in cents, printed as typed rather than rounded to whole cents: the breaker
   line is 2.6 by default and would read as 3. */
function aiGuardNum(v) {
  var n = Number(v);
  if (v == null || !isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function aiGuardText(v, fallback) {
  var n = aiGuardNum(v);
  return n == null ? fallback : n + ' cents';
}

function aiPausedNames(g) {
  var list = g && Array.isArray(g.paused) ? g.paused : [];
  return list.filter(function (x) { return typeof x === 'string' && x; });
}

function aiPaintGuards() {
  if (!aiEl || !aiEl.guardGroup) return;
  var g = aiState.guards;
  var e = aiEl;
  e.guardNote.textContent = aiState.guardErr || '';
  e.guardNote.hidden = !aiState.guardErr;
  if (!g) {
    e.guardPlainOn.hidden = true;
    e.guardWhy.hidden = true;
    e.guardPaused.innerHTML = '';
    e.guardRead.textContent = aiState.guardErr ? '' : 'Reading the guards.';
    e.guardGroup.state.textContent = aiState.guardErr ? 'unavailable' : '';
    /* Nothing was read, so there is nothing to change: the controls stay out of reach rather
       than offering to write a value nobody has seen. */
    aiDisable([e.guardPlain, e.guardOn, e.guardCeiling, e.guardDeep, e.guardBreaker, e.guardHard, e.guardClear], true);
    aiPaintHead();
    return;
  }
  aiDisable([e.guardPlain, e.guardOn, e.guardCeiling, e.guardDeep, e.guardBreaker, e.guardHard], false);

  e.guardPlain.setAttribute('aria-checked', String(!!g.plain));
  e.guardPlainOn.hidden = !g.plain;
  e.guardOn.setAttribute('aria-checked', String(!!g.breaker_on));
  [[e.guardCeiling, g.ceiling_cents], [e.guardDeep, g.deep_ceiling_cents], [e.guardBreaker, g.breaker_cents], [e.guardHard, g.breaker_hard]]
    .forEach(function (pair) {
      if (pair[0].getAttribute('data-editing') === '1') return;
      var n = aiGuardNum(pair[1]);
      pair[0].value = n == null ? '' : String(n);
    });

  var ceil = aiGuardNum(g.ceiling_cents);
  var line = aiGuardNum(g.breaker_cents), hard = aiGuardNum(g.breaker_hard);
  e.guardRead.innerHTML = '';
  e.guardRead.appendChild(el('span', 'aireadline',
    (ceil == null ? 'The ceiling on one question is not set.'
      : 'One question may cost ' + ceil + ' cents at most.') +
    ' The breaker is ' + (g.breaker_on ? 'on' : 'off') +
    (line == null || hard == null ? '.' : ', at ' + line + ' cents, hard at ' + hard + ' cents.')));
  /* mean_cents is null with the breaker off, and null again until there are ten answers to
     average, so neither case is printed as a number. */
  e.guardRead.appendChild(el('span', 'aireadline',
    (g.breaker_on
      ? 'Running mean: ' + aiGuardText(g.mean_cents, 'nothing measured yet') +
        ', over the last twenty answers.'
      : 'Nothing is measured while the breaker is off.') +
    (aiWhen(g.at) ? ' Last read ' + aiWhen(g.at) + '.' : '')));

  var paused = aiPausedNames(g);
  e.guardPaused.innerHTML = '';
  if (paused.length) {
    paused.forEach(function (id) {
      var info = aiFeatureInfo(id);
      e.guardPaused.appendChild(el('li', 'aichip aichipflags', info ? info.label : id));
    });
  } else {
    e.guardPaused.appendChild(el('li', 'note', g.breaker_on
      ? 'Nothing is paused.' : 'Nothing is paused, and nothing can be while the breaker is off.'));
  }

  /* note is null with the breaker off and null whenever nothing tripped, so a null is never
     printed as a reason for a pause. */
  var why = typeof g.note === 'string' ? g.note.trim() : '';
  if (paused.length) {
    e.guardWhy.textContent = why
      ? 'Paused: ' + why + '.'
      : 'Paused, with no reason kept.';
    e.guardWhy.hidden = false;
  } else if (why) {
    e.guardWhy.textContent = 'The breaker\'s last word: ' + why + '.';
    e.guardWhy.hidden = false;
  } else {
    e.guardWhy.textContent = '';
    e.guardWhy.hidden = true;
  }
  e.guardClear.disabled = !paused.length && !why;

  e.guardGroup.state.textContent = (g.breaker_on ? 'On' : 'Off, so nothing is measured') +
    (paused.length ? ' · ' + paused.length + ' paused' : '');
  /* What is paused shows on the feature rows and in the strip as well. */
  if (aiState.settings) aiPaintFeatures();
  aiPaintHead();
}

/* Writes one guard. The read keys and the write keys are not the same words: ceiling_cents is
   written as 'ceiling', breaker_cents as 'breaker', breaker_hard as 'hard'; plain and
   breaker_on keep their own names, and 'reset' clears the pause and carries no value. */
function aiGuardSet(key, num, flag, errAt, els) {
  if (!aiEl) return Promise.resolve(null);
  var at = errAt || aiEl.guardNote;
  if (at) { at.hidden = true; at.textContent = ''; }
  aiDisable(els || [], true);
  return StudyAuth.admin.ai.guardSet(key, num, flag).then(function (r) {
    aiDisable(els || [], false);
    if (r && r.ok) return aiLoadGuards();
    aiShowAt(at, r && r.error === 'bad_key'
      ? 'The server does not know that guard.' : ai33Err(r, null));
    /* A refused write must leave the controls showing what is stored, not what was asked. */
    aiPaintGuards();
    return r;
  }, function (err) {
    aiDisable(els || [], false);
    aiShowAt(at, aiErrText(err));
    aiPaintGuards();
    return null;
  });
}

function aiGuardNumChange(inp, key, errAt) {
  inp.removeAttribute('data-editing');
  if (errAt) { errAt.hidden = true; errAt.textContent = ''; }
  var raw = inp.value.trim().replace(/[¢$]/g, '');
  if (raw === '') { aiPaintGuards(); return; }
  var n = Number(raw);
  if (!isFinite(n) || n < 0) { aiShowAt(errAt, 'Numbers only, in cents.'); return; }
  var max = AI_GUARD_MAX[key] || AI_GUARD_MAX_CENTS;
  if (n > max) {
    aiShowAt(errAt, 'The server holds this to ' + max + ' cents.');
    return;
  }
  aiGuardSet(key, n, null, errAt, [inp]);
}

/* Reading the guards recomputes the breaker on the server and writes a row, so this is called
   when the panel loads and when the owner asks for it, and never from a timer. */
function aiLoadGuards() {
  if (!aiEl) return Promise.resolve();
  return StudyAuth.admin.ai.guards().then(function (r) {
    if (!aiEl) return;
    if (!r || !r.ok) {
      aiState.guards = null;
      aiState.guardErr = ai33Err(r, null);
      aiPaintGuards();
      return;
    }
    aiState.guards = r;
    aiState.guardErr = '';
    aiPaintGuards();
  }, function (err) {
    if (!aiEl) return;
    aiState.guards = null;
    aiState.guardErr = ai33Err(null, err);
    aiPaintGuards();
  });
}

/* ---- codes ---- */

/* The server's clock, not the device's: this machine was twelve hours out on 2026-09-17, and a
   code that ends at seven in the morning must not look expired because a laptop says so. */
function aiPassLeft(iso) {
  if (!iso) return '';
  var at = Date.parse(iso);
  if (!isFinite(at)) return '';
  var mins = Math.round((at - (Date.now() + aiState.passSkew)) / 60000);
  if (mins <= 0) return 'ended';
  if (mins < 60) return 'in ' + mins + ' min';
  if (mins < 60 * 36) return 'in ' + Math.round(mins / 60) + ' h';
  return 'in ' + Math.round(mins / 1440) + ' days';
}

/* Always printed in the owner's own zone, whatever zone the device is in. */
function aiPassWhen(iso) {
  if (!iso) return 'no end date';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'America/Detroit', weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit'
    }) + ' Detroit';
  } catch (e) { return String(iso); }
}

/* What a code may use, in words: everything the owner has, or the list it was given, and what
   has been switched off for it either way. */
function aiPassWhat(p) {
  var on = p.all_features ? 'all features' : ((p.features || []).filter(function (f) { return f !== 'textbook'; }).join(', ') || 'nothing');
  if (p.may_book) on += ', textbook';
  var off = (p.denied || []).filter(function (f) { return f !== 'textbook'; });
  return on + (off.length ? ' (' + off.join(', ') + ' off)' : '');
}

/* live comes from the server, which owns the clock that decides. The rest only explains why. */
function aiPassState(p) {
  if (p.revoked_at) return 'deleted';
  if (!p.enabled) return 'off';
  if (p.live === false) return p.expires_at ? 'ended' : 'off';
  if (Number(p.left_cents) <= 0) return 'out of money';
  return 'live';
}

function aiPassCreate() {
  if (!aiEl) return;
  aiShowAt(aiEl.passErr, '');
  aiEl.passErr.hidden = true;
  var label = aiEl.passLabel.value.trim();
  if (!label) { aiShowAt(aiEl.passErr, 'Say who it is for.'); return; }
  var money = Number(aiEl.passMoney.value.trim().replace(/^\$/, '') || '0');
  if (!isFinite(money) || money < 0) { aiShowAt(aiEl.passErr, 'Money is a number of dollars.'); return; }
  var feats = [], body0 = {};
  if (aiSwitchOn(aiEl.passAsk)) feats.push('ask');
  if (!feats.length) { aiShowAt(aiEl.passErr, 'Tick at least one feature.'); return; }
  if (aiSwitchOn(aiEl.passBook)) feats.push('textbook');
  if (aiSwitchOn(aiEl.passAll)) body0.all_features = true;
  var dailyRaw = aiEl.passDaily.value.trim().replace(/^\$/, '');
  var daily = dailyRaw === '' ? null : Number(dailyRaw);
  if (daily !== null && (!isFinite(daily) || daily < 0)) { aiShowAt(aiEl.passErr, 'A daily cap is a number of dollars.'); return; }
  var when = aiEl.passWhen.value, body = body0;
  body.label = label;
  body.budget_cents = Math.round(money * 100);
  body.features = feats;
  if (daily !== null) body.daily_cents = Math.round(daily * 100);
  if (when === 'morning') body.when = 'morning';
  else if (when === 'hours') { body.when = 'hours'; body.hours = 3; }
  else body.when = 'none';
  aiDisable([aiEl.passMake], true);
  StudyAuth.admin.ai.passCreate(body).then(function (r) {
    aiDisable([aiEl.passMake], false);
    if (!r || !r.ok) { aiShowAt(aiEl.passErr, aiRefusal(r)); return; }
    aiEl.passLabel.value = '';
    aiEl.passMoney.value = '';
    aiEl.passDaily.value = '';
    aiState.passNew = r;
    aiPaintNewPass();
    aiLoadPasses();
  }, function (err) {
    aiDisable([aiEl.passMake], false);
    aiShowAt(aiEl.passErr, aiErrText(err));
  });
}

function aiPaintNewPass() {
  var r = aiState.passNew;
  if (!aiEl || !r) return;
  aiEl.passNew.innerHTML = '';
  aiEl.passNew.hidden = false;
  aiEl.passNew.appendChild(el('p', 'aipassnewlab', 'Give them this code. It is shown once.'));
  var row = el('div', 'row wrap');
  row.appendChild(el('code', 'aipasscode', String(r.code || '')));
  var copy = el('button', 'btn sm', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', function () {
    try { navigator.clipboard.writeText(String(r.code || '')); copy.textContent = 'Copied'; } catch (e) {}
  });
  row.appendChild(copy);
  var hide = el('button', 'btn sm out', 'Hide');
  hide.type = 'button';
  hide.addEventListener('click', function () { aiState.passNew = null; aiEl.passNew.hidden = true; });
  row.appendChild(hide);
  aiEl.passNew.appendChild(row);
  aiEl.passNew.appendChild(el('p', 'note',
    'It is their sync code as well, so their progress follows it. ' +
    (r.expires_at ? 'It ends ' + aiPassWhen(r.expires_at) + '.' : 'It has no end date.')));
}

function aiPassSet(patch, row) {
  return StudyAuth.admin.ai.passSet(patch).then(function (r) {
    if (r && r.ok) return aiLoadPasses();
    if (row) aiShowAt(row.err, aiRefusal(r));
    return r;
  }, function (err) {
    if (row) aiShowAt(row.err, aiErrText(err));
    return null;
  });
}

function aiPassRow(p) {
  var li = el('li', 'aipass');
  var head = el('div', 'aipasshead');
  var who = el('div', 'aipasswho');
  var title = el('div', 'aipasstitle');
  title.appendChild(el('span', 'aipassname', p.label || 'code'));
  /* The code itself is shown once when it is made and never stored in the clear, so a code is
     told apart by who it is for and when it was made, not by a piece of itself. */
  title.appendChild(el('span', 'aipasstail', 'made ' + aiWhen(p.created_at)));
  var state = aiPassState(p);
  title.appendChild(el('span', 'aipassstate' + (state === 'live' ? ' on' : ''), state));
  who.appendChild(title);
  var meta = el('p', 'aifeatmeta',
    dollars(Number(p.left_cents)) + ' left of ' + dollars(Number(p.budget_cents)) +
    ' · ' + aiCount(p.calls, 'call') + ' · ' + aiPassWhat(p) +
    ' · ' + (p.expires_at ? aiPassWhen(p.expires_at) + ' (' + aiPassLeft(p.expires_at) + ')' : 'no end date'));
  who.appendChild(meta);
  head.appendChild(who);
  var sw = aiSwitch(p.label || 'code');
  sw.setAttribute('aria-checked', String(!!p.enabled));
  head.appendChild(sw);
  li.appendChild(head);

  /* One switch per feature, plus the textbook grant, plus the all features mode. Off is a denial
     on the code, so it keeps holding when the code follows everything the owner has. */
  var sws = el('div', 'aipassfeats');
  var row = { err: el('p', 'err-inline'), li: li };
  row.err.hidden = true;
  function featSwitch(id, label, on) {
    var wrap = el('div', 'aipassfeat');
    wrap.appendChild(el('span', 'lbl', label));
    var b = aiSwitch(label + ' for ' + (p.label || 'this code'));
    b.setAttribute('aria-checked', String(!!on));
    b.addEventListener('click', function () {
      if (id === 'all') aiPassSet({ id: p.id, all_features: !aiSwitchOn(b) }, row);
      else aiPassSet({ id: p.id, feature: id, on: !aiSwitchOn(b) }, row);
    });
    wrap.appendChild(b);
    sws.appendChild(wrap);
  }
  featSwitch('all', 'All features', p.all_features);
  (aiState.passFeatures || []).forEach(function (f) {
    var denied = (p.denied || []).indexOf(f.id) >= 0;
    var on = !denied && (p.all_features || (p.features || []).indexOf(f.id) >= 0);
    featSwitch(f.id, f.name || f.id, on);
  });
  featSwitch('textbook', 'Textbook', p.may_book);
  li.appendChild(sws);

  var ctl = el('div', 'row wrap aipassctl');
  function btn(text, patch, confirmText) {
    var b = el('button', 'btn sm out', text);
    b.type = 'button';
    b.addEventListener('click', function () {
      row.err.hidden = true;
      if (confirmText && !window.confirm(confirmText)) return;
      aiPassSet(patch(), row);
    });
    ctl.appendChild(b);
    return b;
  }
  btn('Add $1', function () { return { id: p.id, add_cents: 100 }; });
  if (aiPassState(p) === 'live') {
    /* An extension adds to the end it already has, so pressing it at half past five on a code
       that ends at six leaves it ending at seven, not at half past six. */
    if (p.expires_at) {
      btn('+1 h', function () { return { id: p.id, extend_hours: 1 }; });
      btn('+3 h', function () { return { id: p.id, extend_hours: 3 }; });
      btn('An hour less', function () { return { id: p.id, extend_hours: -1 }; });
    }
    btn('Ends in the morning', function () { return { id: p.id, when: 'morning' }; });
    btn('No end date', function () { return { id: p.id, when: 'none' }; }, 'Let this code run with no end date?');
    btn('End now', function () { return { id: p.id, when: 'now' }; }, 'End this code now? They lose the Ask features straight away.');
  } else {
    /* Bringing one back always sets a new end, so a revived code is never permanent by accident. */
    btn('Back for 3 hours', function () { return { id: p.id, revive: true, when: 'hours', hours: 3 }; });
    btn('Back until morning', function () { return { id: p.id, revive: true, when: 'morning' }; });
  }
  /* Show the code itself. Codes minted before it was kept have nothing to show, and say so. */
  var codeBtn = el('button', 'btn sm out', 'Show the code');
  codeBtn.type = 'button';
  var codeOut = el('div', 'aipasscodeout');
  codeOut.hidden = true;
  codeBtn.addEventListener('click', function () {
    if (!codeOut.hidden) { codeOut.hidden = true; codeOut.innerHTML = ''; codeBtn.textContent = 'Show the code'; return; }
    StudyAuth.admin.ai.passCode(p.id).then(function (r) {
      codeOut.innerHTML = '';
      codeOut.hidden = false;
      if (!r || !r.ok) {
        codeOut.appendChild(el('p', 'note', r && r.error === 'not_kept'
          ? 'This one was made before codes were kept, so there is nothing to show. It still works; if you have lost it, make a new one.'
          : aiRefusal(r)));
        return;
      }
      codeBtn.textContent = 'Hide the code';
      var row2 = el('div', 'row wrap');
      row2.appendChild(el('code', 'aipasscode', String(r.code || '')));
      var copy2 = el('button', 'btn sm', 'Copy');
      copy2.type = 'button';
      copy2.addEventListener('click', function () {
        try { navigator.clipboard.writeText(String(r.code || '')); copy2.textContent = 'Copied'; } catch (e) {}
      });
      row2.appendChild(copy2);
      codeOut.appendChild(row2);
    }, function (err) {
      codeOut.hidden = false;
      codeOut.innerHTML = '';
      codeOut.appendChild(el('p', 'err-inline', aiErrText(err)));
    });
  });
  ctl.appendChild(codeBtn);

  /* Their conversations, in full. The owner tells a code holder these are kept when handing the
     code over; this is where they are read. Newest first, with a copy of the lot as JSON for
     taking them elsewhere. */
  var chatsBtn = el('button', 'btn sm out', 'Their chats');
  chatsBtn.type = 'button';
  var chatsOut = el('div', 'aipasschats');
  chatsOut.hidden = true;
  chatsBtn.addEventListener('click', function () {
    if (!chatsOut.hidden) { chatsOut.hidden = true; chatsOut.innerHTML = ''; chatsBtn.textContent = 'Their chats'; return; }
    chatsOut.hidden = false;
    chatsOut.innerHTML = '';
    chatsOut.appendChild(el('p', 'note', 'Loading.'));
    StudyAuth.admin.ai.passChats(p.id).then(function (r) {
      chatsOut.innerHTML = '';
      if (!r || !r.ok) { chatsOut.appendChild(el('p', 'err-inline', aiRefusal(r))); return; }
      var list = Array.isArray(r.chats) ? r.chats : [];
      chatsBtn.textContent = 'Hide chats';
      if (!list.length) { chatsOut.appendChild(el('p', 'note', 'No chats yet.')); return; }
      var head = el('div', 'row wrap');
      head.appendChild(el('span', 'note', (r.total || list.length) + ' in all' + (list.length < (r.total || 0) ? ', newest ' + list.length + ' shown' : '')));
      var dump = el('button', 'btn sm', 'Copy all as JSON');
      dump.type = 'button';
      dump.addEventListener('click', function () {
        try { navigator.clipboard.writeText(JSON.stringify(list, null, 1)); dump.textContent = 'Copied'; } catch (e) {}
      });
      head.appendChild(dump);
      chatsOut.appendChild(head);
      list.forEach(function (c) {
        var item = el('div', 'aipasschat');
        item.appendChild(el('p', 'aifeatmeta', aiWhen(c.created_at) + ' · ' + (c.material || '') +
          (c.level ? ' · ' + (c.level === 'careful' ? 'thorough' : c.level) : '') + (c.intent ? ' (' + c.intent + ')' : '') +
          (c.rating === 1 ? ' · rated helpful' : c.rating === -1 ? ' · rated not helpful' : '')));
        if (c.quote) item.appendChild(el('p', 'aipasschatq', 'Selected: ' + c.quote));
        item.appendChild(el('p', 'aipasschatq', 'Q: ' + (c.question || '')));
        item.appendChild(el('p', 'aipasschata', c.answer || (c.status !== 'ok' ? '(no answer: ' + c.status + ')' : '')));
        chatsOut.appendChild(item);
      });
    }, function (err) {
      chatsOut.innerHTML = '';
      chatsOut.appendChild(el('p', 'err-inline', aiErrText(err)));
    });
  });
  ctl.appendChild(chatsBtn);

  var spendBtn = el('button', 'btn sm out', 'Where it went');
  spendBtn.type = 'button';
  ctl.appendChild(spendBtn);
  var del = el('button', 'btn sm out', 'Delete');
  del.type = 'button';
  del.addEventListener('click', function () {
    if (!window.confirm('Delete this code? Their saved progress stays, but the code stops working and cannot be brought back.')) return;
    StudyAuth.admin.ai.passDelete(p.id).then(function (r) {
      if (r && r.ok) return aiLoadPasses();
      aiShowAt(row.err, aiRefusal(r));
    }, function (err) { aiShowAt(row.err, aiErrText(err)); });
  });
  ctl.appendChild(del);
  li.appendChild(ctl);

  /* A time the owner types, read in their own zone by the server. The device clock plays no
     part, which is the point: this laptop was twelve hours out on the day this was built. */
  var when = el('div', 'row wrap aipasswhen');
  var whenInput = document.createElement('input');
  whenInput.type = 'datetime-local';
  whenInput.className = 'in sm';
  whenInput.setAttribute('aria-label', 'When ' + (p.label || 'this code') + ' ends, Detroit time');
  when.appendChild(el('span', 'lbl', 'Ends at'));
  when.appendChild(whenInput);
  var whenSet = el('button', 'btn sm out', 'Set');
  whenSet.type = 'button';
  whenSet.addEventListener('click', function () {
    row.err.hidden = true;
    var v = whenInput.value.trim();
    if (!v) { aiShowAt(row.err, 'Pick a date and time first.'); return; }
    aiPassSet({ id: p.id, when: 'local', local: v }, row);
  });
  when.appendChild(whenSet);
  when.appendChild(el('span', 'note', 'Detroit time'));
  li.appendChild(when);

  li.appendChild(codeOut);
  li.appendChild(chatsOut);

  var spend = el('div', 'aipassspend');
  spend.hidden = true;
  li.appendChild(spend);
  spendBtn.addEventListener('click', function () {
    if (!spend.hidden) { spend.hidden = true; return; }
    spend.innerHTML = '';
    spend.hidden = false;
    spend.appendChild(el('p', 'note', 'Loading.'));
    StudyAuth.admin.ai.passSpend(p.id).then(function (r) {
      spend.innerHTML = '';
      if (!r || !r.ok) { spend.appendChild(el('p', 'err-inline', aiRefusal(r))); return; }
      var mats = r.by_material || [];
      if (!mats.length) { spend.appendChild(el('p', 'note', 'Nothing spent yet.')); return; }
      var t = el('table', 'aitable');
      var head2 = document.createElement('tr');
      ['Material', 'Feature', 'Calls', 'Spent'].forEach(function (h) { head2.appendChild(el('th', null, h)); });
      t.appendChild(head2);
      mats.forEach(function (m) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', null, m.material || ''));
        tr.appendChild(el('td', null, m.feature || ''));
        tr.appendChild(el('td', null, String(m.calls)));
        tr.appendChild(el('td', null, spendDollars(m.cents)));
        t.appendChild(tr);
      });
      spend.appendChild(t);
      (r.by_day || []).slice(0, 7).forEach(function (d) {
        spend.appendChild(el('p', 'note', d.day + ': ' + spendDollars(d.cents) + ', ' + aiCount(d.calls, 'call')));
      });
    }, function (err) {
      spend.innerHTML = '';
      spend.appendChild(el('p', 'err-inline', aiErrText(err)));
    });
  });

  li.appendChild(row.err);
  sw.addEventListener('click', function () { aiPassSet({ id: p.id, enabled: !aiSwitchOn(sw) }, row); });
  /* Everything under the name folds away. A code that is not live starts folded, so ended and
     switched off codes stop filling the list; a live one starts open. Opening or folding one is
     remembered while the panel stays open, so a repaint after a change does not undo it. */
  var body = el('div', 'aipassbody');
  while (head.nextSibling) body.appendChild(head.nextSibling);
  li.appendChild(body);
  li.appendChild(row.err);   /* outside the fold: the switch by the name can fail while folded */
  var open = aiState.passOpen && Object.prototype.hasOwnProperty.call(aiState.passOpen, p.id)
    ? aiState.passOpen[p.id] : state === 'live';
  var fold = el('button', 'aipassfold', open ? 'Hide' : 'Show');
  fold.type = 'button';
  fold.setAttribute('aria-expanded', String(open));
  fold.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' the controls for ' + (p.label || 'this code'));
  body.hidden = !open;
  fold.addEventListener('click', function () {
    var now = body.hidden;
    body.hidden = !now;
    (aiState.passOpen = aiState.passOpen || {})[p.id] = now;
    fold.textContent = now ? 'Hide' : 'Show';
    fold.setAttribute('aria-expanded', String(now));
    fold.setAttribute('aria-label', (now ? 'Hide' : 'Show') + ' the controls for ' + (p.label || 'this code'));
  });
  head.insertBefore(fold, sw);
  return li;
}

function aiPaintPasses() {
  if (!aiEl || !aiEl.passList) return;
  aiEl.passList.innerHTML = '';
  (aiState.passes || []).forEach(function (p) { aiEl.passList.appendChild(aiPassRow(p)); });
  if (!(aiState.passes || []).length) {
    aiEl.passList.appendChild(el('li', 'note', 'No codes yet.'));
  }
  aiEl.passNote.textContent = aiState.passErr || '';
  aiEl.passNote.hidden = !aiState.passErr;
  var live = (aiState.passes || []).filter(function (p) { return aiPassState(p) === 'live'; }).length;
  aiEl.passGroup.state.textContent = (aiState.passes || []).length
    ? aiCount(aiState.passes.length, 'code') + ' · ' + live + ' live'
    : 'none yet';
}

function aiLoadPasses() {
  if (!aiEl) return Promise.resolve();
  return StudyAuth.admin.ai.passes().then(function (r) {
    if (!aiEl) return;
    if (!r || !r.ok) {
      aiState.passes = [];
      aiState.passErr = r && r.error === 'forbidden' ? 'That admin session was refused. Sign in again.'
        : 'Run 0017_ai_passes.sql in Supabase to hand out codes.';
      aiPaintPasses();
      return;
    }
    aiState.passes = Array.isArray(r.passes) ? r.passes : [];
    aiState.passFeatures = Array.isArray(r.features) ? r.features.slice() : [];
    /* SAQ grading has no feature row (its settings are the global ones), but a code can carry it
       since 0030, so it gets a switch on every code like the rest. */
    if (!aiState.passFeatures.some(function (f) { return f && f.id === 'saq'; })) {
      aiState.passFeatures.push({ id: 'saq', name: 'SAQ grading' });
    }
    aiState.passErr = '';
    var serverNow = Date.parse(r.now);
    aiState.passSkew = isFinite(serverNow) ? serverNow - Date.now() : 0;
    aiPaintPasses();
  }, function () {
    if (!aiEl) return;
    aiState.passes = [];
    aiState.passErr = 'Run 0017_ai_passes.sql in Supabase to hand out codes.';
    aiPaintPasses();
  });
}

function aiLoad() {
  if (!aiEl) return Promise.resolve();
  aiNote('');
  /* The chats have their own RPC and their own failure line inside their group, so they load
     alongside the settings rather than after them. */
  aiLoadChats(false);
  /* The features list failing (0011 not run, say) must not take SAQ grading's controls down
     with it, so its failure is caught here and shown inside the Features group. */
  var feats = StudyAuth.admin.ai.features().then(function (r) { return r; }, function (err) {
    return { ok: false, error: err && err.message === 'http_404' ? 'missing' : 'unreachable' };
  });
  return Promise.all([
    StudyAuth.admin.ai.settings(),
    StudyAuth.admin.ai.models(),
    feats
  ]).then(function (all) {
    if (!aiEl) return;
    var s = all[0], m = all[1], f = all[2];
    if (!s || !s.ok) {
      aiEl.body.hidden = true;
      aiNote(s && s.error === 'forbidden'
        ? 'That admin session was refused. Sign in again.'
        : 'Run 0010_ai_grading.sql in Supabase to turn this on.');
      return;
    }
    aiState.settings = s.settings || null;
    aiState.models = (m && m.ok && Array.isArray(m.models)) ? m.models : [];
    if (f && f.ok) {
      aiState.features = Array.isArray(f.features) ? f.features : [];
      aiState.saq = { today_cents: f.saq_today_cents, month_cents: f.saq_month_cents };
      aiState.featErr = '';
    } else {
      aiState.features = [];
      aiState.saq = null;
      aiState.featErr = f && f.error === 'forbidden' ? 'That admin session was refused. Sign in again.'
        : f && f.error === 'missing' ? 'Run 0011_ai_features.sql in Supabase to list the other features.'
        : 'Could not load the other features.';
    }
    aiEl.body.hidden = false;
    paintAi();
    /* Each group loads on its own: one that throws must not stop the others (a misnamed
       call in the reports loader once kept the spending from ever loading). The guards are
       read here and on their own button only: reading them recomputes the breaker and writes
       a row, so they must never be on a timer or in a polling path. */
    var usage = aiLoadUsage();
    [aiLoadPasses, aiLoadTickets, aiLoadFlags, aiLoadCorrections, aiLoadGuards].forEach(function (load) {
      try { load(); } catch (e) { if (window.console) console.error(e); }
    });
    return usage;
  }, function (err) {
    if (!aiEl) return;
    aiEl.body.hidden = true;
    aiNote(aiErrText(err));
  });
}

/* ---- chats ---- */

/* Cents to one place: an answer costs a fraction of a cent to a few. A cost that would print
   as 0.0 says so rather than reading as free, as shortDollars does for the Spend line. */
function aiCents(mc) {
  var c = Number(mc || 0) / 1e6;
  if (!isFinite(c) || c <= 0) return '0.0¢';
  return c < 0.05 ? '<0.1¢' : c.toFixed(1) + '¢';
}

function aiLocalDate(d) {
  d = d || new Date();
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
}

function aiChatErrText(err) {
  if (err && err.message === 'http_404') return 'Run 0012_ai_chats.sql in Supabase to save chats.';
  return aiErrText(err);
}

function aiChatRefusal(r, what) {
  return r && r.error === 'forbidden' ? 'That admin session was refused. Sign in again.' : what;
}

/* A context label is a string as the Edge Function writes it. Anything else that turns up in
   the jsonb is read for a label or name, and dropped if it has neither. */
function aiLabelText(l) {
  if (typeof l === 'string') return l;
  if (typeof l === 'number' && isFinite(l)) return String(l);
  if (l && typeof l === 'object') {
    var s = l.label != null ? l.label : l.name != null ? l.name : l.text;
    if (typeof s === 'string' || typeof s === 'number') return String(s);
  }
  return '';
}

function aiChatRating(c) {
  return Number(c.rating) === 1 ? 1 : Number(c.rating) === -1 ? -1 : null;
}

var AI_THUMB = 'M3 10h4v11H3zM7 10l4-8c1.4 0 3 1 3 3v4h5a2 2 0 0 1 2 2.3l-1.3 7.7A2 2 0 0 1 17.7 21H7';

function aiThumb() {
  var NS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'aithumb');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  var p = document.createElementNS(NS, 'path');
  p.setAttribute('d', AI_THUMB);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linejoin', 'round');
  p.setAttribute('stroke-linecap', 'round');
  svg.appendChild(p);
  return svg;
}

/* Two toggles, helpful and not. Tapping the pressed one clears it. The change shows at once
   and goes back if the server does not take it. While a save is out the pair is marked
   aria-disabled rather than disabled, so keyboard focus stays on the thumb that was pressed. */
function aiChatRater(c) {
  var wrap = el('div', 'aichatrate');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Rate this answer');
  var err = el('p', 'err-inline aichaterr');
  err.hidden = true;
  var busy = false;

  function mk(cls, label, value) {
    var b = el('button', 'airate ' + cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.appendChild(aiThumb());
    b.addEventListener('click', function () { rate(value); });
    wrap.appendChild(b);
    return b;
  }
  var up = mk('up', 'Helpful', 1);
  var down = mk('down', 'Not helpful', -1);

  function paint() {
    var now = aiChatRating(c);
    up.setAttribute('aria-pressed', String(now === 1));
    down.setAttribute('aria-pressed', String(now === -1));
  }
  function hold(on) {
    busy = on;
    [up, down].forEach(function (b) {
      if (on) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
  }
  function rate(value) {
    if (busy) return;
    var prev = aiChatRating(c);
    var next = prev === value ? null : value;
    var gen = aiChats.gen;
    function back(text) {
      c.rating = prev;
      paint();
      err.textContent = text;
      err.hidden = false;
    }
    err.hidden = true;
    c.rating = next;
    paint();
    hold(true);
    StudyAuth.admin.ai.chatRate(c.id, next).then(function (r) {
      hold(false);
      if (r && r.ok) {
        /* The counts in the summary follow the tap. A load since then already has the
           server's own counts, which include this rating. */
        if (aiEl && gen === aiChats.gen) { aiChatsCount(prev, next); aiPaintChats(); }
        return;
      }
      back(aiChatRefusal(r, 'Could not save that rating.'));
    }, function (e) {
      hold(false);
      back(aiChatErrText(e));
    });
  }

  paint();
  return { wrap: wrap, err: err };
}

function aiChatsCount(prev, next) {
  var s = aiChats.stats;
  if (!s || prev === next) return;
  var bump = function (k, by) { s[k] = Math.max(0, Number(s[k] || 0) + by); };
  if (prev === 1) bump('helpful', -1);
  if (prev === -1) bump('unhelpful', -1);
  if (next === 1) bump('helpful', 1);
  if (next === -1) bump('unhelpful', 1);
}

/* What opening a row shows. Built on first open, so twenty closed rows do not each carry an
   answer of several thousand characters in the document. */
function aiChatFill(body, c) {
  if (c.quote) {
    body.appendChild(el('p', 'lbl', 'Quote'));
    body.appendChild(el('p', 'aichatquote', String(c.quote)));
  }
  body.appendChild(el('p', 'lbl', 'Answer'));
  body.appendChild(c.answer
    ? el('p', 'aichatanswer', String(c.answer))
    : el('p', 'note', 'No answer was saved.'));

  var chips = el('ul', 'aichips');
  (Array.isArray(c.labels) ? c.labels : []).forEach(function (l) {
    var text = aiLabelText(l);
    if (text) chips.appendChild(el('li', 'aichip', text));
  });
  if (c.progress === true) chips.appendChild(el('li', 'aichip aichipflag', 'used progress'));
  if (c.notes === true) chips.appendChild(el('li', 'aichip aichipflag', 'used notes'));
  /* What the checks on the page caught in this answer (0032), and what they were. The
     sentences themselves are in Flags. */
  var nflags = Number(c.flags) || 0;
  if (nflags > 0) {
    var kinds = (Array.isArray(c.flag_kinds) ? c.flag_kinds : []).filter(function (k) {
      return typeof k === 'string' && k;
    });
    chips.appendChild(el('li', 'aichip aichipflags',
      kinds.length ? 'flagged: ' + kinds.join(', ') : aiCount(nflags, 'flag')));
  }
  if (chips.firstChild) {
    body.appendChild(el('p', 'lbl', 'Context'));
    body.appendChild(chips);
  }

  var info = [];
  if (c.model) info.push(String(c.model));
  if (c.input_tokens != null || c.output_tokens != null) {
    info.push(Number(c.input_tokens || 0) + ' in, ' + Number(c.output_tokens || 0) + ' out');
  }
  if (c.latency_ms) info.push((Number(c.latency_ms) / 1000).toFixed(1) + ' s');
  /* A prefix read costs a tenth and a prefix written costs a quarter more, so the two are
     worth telling apart rather than adding up (0032). */
  var cr = Number(c.cache_read) || 0, cw = Number(c.cache_write) || 0;
  if (cr || cw) info.push('cache ' + cr + ' read, ' + cw + ' written');
  if (c.turn != null) info.push('turn ' + Number(c.turn));
  if (info.length) body.appendChild(el('p', 'aimeta aichatinfo', info.join(' · ')));
}

/* One chat: a disclosure button (time, feature, cost, the question on one line) with the two
   thumbs beside it rather than inside it, so rating a row never opens it. */
function aiChatRow(c) {
  var li = el('li', 'aichat');
  var head = el('div', 'aichathead');

  var open = el('button', 'aichatopen');
  open.type = 'button';
  open.setAttribute('aria-expanded', 'false');
  var bodyId = 'aichat-' + (++aiUid);
  open.setAttribute('aria-controls', bodyId);

  var text = el('span', 'aichattext');
  var meta = el('span', 'aichatmeta');
  meta.appendChild(el('span', 'aichatwhen', aiWhen(c.created_at)));
  var info = aiFeatureInfo(c.feature);
  meta.appendChild(el('span', 'aichip aichipfeat', info ? info.short : String(c.feature || 'ask')));
  /* How the answer was reached (0032): page, reuse, haiku, sonnet, escalated. The one that
     costs nothing is the one worth seeing without opening the row. */
  if (c.route) meta.appendChild(el('span', 'aichip aichiproute', String(c.route)));
  /* Which body of sources answered it (0034, readable since 0035). Only when it was not the
     material, since that is almost every row and a chip on all of them says nothing. */
  if (c.mode && c.mode !== 'material') {
    meta.appendChild(el('span', 'aichip aichipmode',
      c.mode === 'links' ? 'links' : c.mode === 'shelf' ? 'shelf' : String(c.mode)));
  }
  if (c.status && c.status !== 'ok') meta.appendChild(el('span', 'aichip aibad', String(c.status)));
  var headFlags = Number(c.flags) || 0;
  if (headFlags > 0) meta.appendChild(el('span', 'aichip aichipflags', headFlags + ' flagged'));
  meta.appendChild(el('span', 'aichatcost', aiCents(c.cost_microcents)));
  text.appendChild(meta);
  text.appendChild(el('span', 'aichatq', String(c.question || '')));
  open.appendChild(text);
  var chev = el('span', 'aichev');
  chev.setAttribute('aria-hidden', 'true');
  open.appendChild(chev);

  var rater = aiChatRater(c);
  head.appendChild(open);
  head.appendChild(rater.wrap);
  li.appendChild(head);
  li.appendChild(rater.err);

  var body = el('div', 'aichatbody');
  body.id = bodyId;
  body.hidden = true;
  li.appendChild(body);

  open.addEventListener('click', function () {
    var on = open.getAttribute('aria-expanded') !== 'true';
    if (on && !body.firstChild) aiChatFill(body, c);
    open.setAttribute('aria-expanded', String(on));
    body.hidden = !on;
  });
  return li;
}

function aiPaintChats() {
  if (!aiEl) return;
  var s = aiChats.stats;
  var total = s ? Number(s.total || 0) : 0;
  aiEl.chatsGroup.state.textContent = s
    ? (total
      ? total + ' saved · ' + Number(s.helpful || 0) + ' helpful · ' + Number(s.unhelpful || 0) + ' not'
        + (Number(s.research || 0) > 0 ? ' · ' + Number(s.research) + ' research' : '')
      : 'none yet')
    : (aiChats.err ? 'unavailable' : '');
  aiEl.chatNote.textContent = aiChats.err;
  aiEl.chatNote.hidden = !aiChats.err;
  aiEl.chatEmpty.hidden = !s || aiChats.list.length > 0;
  aiEl.chatBar.hidden = !s || (!total && !aiChats.list.length);
  aiEl.chatMore.hidden = !aiChats.more;
  aiEl.chatMore.disabled = aiChats.busy;
}

function aiChatsMinId() {
  var min = null;
  aiChats.list.forEach(function (c) {
    var id = Number(c.id);
    if (min === null || id < min) min = id;
  });
  return min;
}

/* more false loads the newest page over whatever is shown; more true appends the page
   before the smallest id already shown. */
function aiLoadChats(more) {
  if (!aiEl || !StudyAuth.isAdmin()) return Promise.resolve();
  if (more && aiChats.busy) return Promise.resolve();
  var before = more ? aiChatsMinId() : null;
  if (more && before === null) return Promise.resolve();
  var gen = more ? aiChats.gen : ++aiChats.gen;
  aiChats.busy = true;
  /* An export's last word belongs to the list it was made from, not to a fresh one. */
  if (!more && !aiChats.exporting) {
    aiEl.chatExportMsg.textContent = '';
    aiEl.chatExportMsg.classList.remove('aibad');
  }
  aiPaintChats();

  return StudyAuth.admin.ai.chats(AI_CHATS_PAGE, before).then(function (r) {
    if (!aiEl || gen !== aiChats.gen) return;
    aiChats.busy = false;
    if (!r || !r.ok) {
      aiChats.err = aiChatRefusal(r, 'Could not load the chats.');
      aiPaintChats();
      return;
    }
    var page = (Array.isArray(r.chats) ? r.chats : []).filter(function (c) {
      return c && typeof c === 'object' && c.id != null && isFinite(Number(c.id));
    });
    if (r.stats && typeof r.stats === 'object') aiChats.stats = r.stats;
    if (!more) {
      aiChats.list = [];
      aiEl.chatList.textContent = '';
    }
    page.forEach(function (c) {
      aiChats.list.push(c);
      aiEl.chatList.appendChild(aiChatRow(c));
    });
    aiChats.err = '';
    var total = aiChats.stats ? Number(aiChats.stats.total || 0) : 0;
    aiChats.more = page.length >= AI_CHATS_PAGE && aiChats.list.length < total;
    aiPaintChats();
  }, function (err) {
    if (!aiEl || gen !== aiChats.gen) return;
    aiChats.busy = false;
    aiChats.err = aiChatErrText(err);
    aiPaintChats();
  });
}

/* Hands the browser a file without a server round trip: a Blob, an object URL, a temporary
   link with download set, and the URL given back once the click has had time to start. */
function aiDownloadJson(obj, name) {
  var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    if (a.parentNode) a.parentNode.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
}

/* Every saved chat, page by page, newest first, until a page comes back empty. */
function aiExportChats() {
  if (!aiEl || !StudyAuth.isAdmin() || aiChats.exporting) return;
  var btn = aiEl.chatExport, msg = aiEl.chatExportMsg;
  var all = [], pages = 0, capped = false;
  aiChats.exporting = true;
  btn.setAttribute('aria-disabled', 'true');
  msg.classList.remove('aibad');
  msg.textContent = 'Exporting…';

  function step(before) {
    if (pages >= AI_CHATS_EXPORT_PAGES) { capped = true; return Promise.resolve(); }
    pages++;
    return StudyAuth.admin.ai.chats(AI_CHATS_EXPORT_PAGE, before).then(function (r) {
      if (!r || !r.ok) {
        var e = new Error('refused');
        e.reply = r;
        throw e;
      }
      var page = Array.isArray(r.chats) ? r.chats : [];
      if (!page.length) return null;
      var min = null;
      page.forEach(function (c) {
        all.push(c);
        var id = c ? Number(c.id) : NaN;
        if (isFinite(id) && (min === null || id < min)) min = id;
      });
      /* A page with no usable id, or one that does not move backwards, cannot be paged past. */
      if (min === null || (before !== null && min >= before)) return null;
      return step(min);
    });
  }

  step(null).then(function () {
    if (!aiEl || !StudyAuth.isAdmin()) return;
    aiDownloadJson({ exported_at: new Date().toISOString(), chats: all },
      'ask-chats-' + aiLocalDate() + '.json');
    msg.textContent = 'Exported ' + aiCount(all.length, 'chat') +
      (capped ? ', stopped after ' + AI_CHATS_EXPORT_PAGES + ' pages' : '');
  }, function (err) {
    if (!aiEl) return;
    msg.classList.add('aibad');
    msg.textContent = err && err.message === 'refused'
      ? aiChatRefusal(err.reply, 'Could not export the chats.')
      : aiChatErrText(err);
  }).then(function () {
    aiChats.exporting = false;
    btn.removeAttribute('aria-disabled');
  });
}

function wireAi() {
  var e = aiEl;

  e.chatExport.addEventListener('click', aiExportChats);
  e.chatMore.addEventListener('click', function () { aiLoadChats(true); });

  e.master.addEventListener('click', function () {
    aiSet({ enabled: !aiSwitchOn(e.master) }, null, [e.master]);
  });

  e.effort.addEventListener('change', function () {
    aiSet({ effort: e.effort.value }, null, [e.effort]);
  });

  /* Each cap saves when its field is left, like every other number in the panel. There was a
     Save button here and nowhere else, so a cap typed and walked away from was silently lost. */
  AI_FIELDS.forEach(function (f) {
    var c = e.cap[f.key], inp = c.input;
    inp.addEventListener('input', function () { inp.setAttribute('data-editing', '1'); });
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', function () {
      inp.removeAttribute('data-editing');
      aiClearFieldErrors();
      var raw = inp.value.trim().replace(/^\$/, '');
      if (raw === '') { paintAi(); return; }
      var n = Number(raw);
      if (!isFinite(n) || n < 0) { aiShowAt(c.err, 'Numbers only.'); return; }
      var patch = {};
      patch[f.key] = f.money ? Math.round(n * 100) : Math.round(n);
      aiSet(patch, null, [inp]).then(function (r) { if (r && r.ok) aiTick(c.tick); });
    });
  });

  e.refresh.addEventListener('click', function () { aiLoad(); });
}

function initAi() {
  if (!StudyAuth.isAdmin()) return;
  var sec = $('aiblock');
  if (!sec || !aiEl) {
    if (sec && sec.parentNode) sec.parentNode.removeChild(sec);
    var body = $('aimount');
    if (!body) return;
    sec = el('section', 'block');
    sec.id = 'aiblock';
    var warn = body.querySelector('.warnbox');
    if (warn) body.insertBefore(sec, warn); else body.appendChild(sec);
    aiEl = buildAi(sec);
    wireAi();
  }
  aiLoad();
}

/* A session that lapses or signs out takes the AI controls with it, rather than leaving
   them in the document behind a hidden panel. */
function aiTeardown() {
  aiPopClose(false);
  var sec = $('aiblock');
  if (sec && sec.parentNode) sec.parentNode.removeChild(sec);
  aiEl = null;
  aiChats = aiChatsFresh(aiChats.gen + 1);
  /* Nothing from the signed out session is kept: the flagged sentences, the corrections and
     the guards are all read again from scratch the next time a session opens the panel. */
  aiState.flags = [];
  aiState.flagStats = null;
  aiState.flagErr = '';
  aiState.corrections = [];
  aiState.corrErr = '';
  aiState.guards = null;
  aiState.guardErr = '';
  var box = $('adminitems');
  if (box) box.innerHTML = '';
}

function initAdmin() {
  if (StudyAuth.role() !== 'admin') return;
  var target = 'admin';
  function paintRole() {
    $('roleAdmin').setAttribute('aria-pressed', String(target === 'admin'));
    $('roleViewer').setAttribute('aria-pressed', String(target === 'viewer'));
  }
  $('roleAdmin').addEventListener('click', function () { target = 'admin'; paintRole(); });
  $('roleViewer').addEventListener('click', function () { target = 'viewer'; paintRole(); });

  $('savecode').addEventListener('click', function () {
    var msg = $('codemsg'), val = $('newcode').value;
    msg.hidden = true;
    if (val.length < 10) { msg.textContent = 'At least 10 characters.'; msg.hidden = false; return; }
    if (!window.confirm('Change the ' + target + ' code? Every other device using it is signed out.')) return;
    StudyAuth.admin.setCode(target, val).then(function (r) {
      if (r && r.ok) {
        $('newcode').value = '';
        msg.style.color = 'var(--ok)';
        msg.textContent = 'The ' + target + ' code is changed. Write it down now.';
      } else {
        msg.style.color = '';
        msg.textContent = r && r.error === 'codes_must_differ'
          ? 'That is already the other role’s code.' : 'Could not change it.';
      }
      msg.hidden = false;
    });
  });

  $('revokeothers').addEventListener('click', function () {
    if (!window.confirm('Sign out every other device, including your own phone?')) return;
    StudyAuth.admin.revokeOthers().then(function (r) {
      $('sessnote').textContent = r && r.ok ? 'Signed out ' + r.revoked + ' other device(s).' : 'Could not do that.';
    });
  });

  $('revokestale').addEventListener('click', function () {
    StudyAuth.admin.revokeStale().then(function (r) {
      if (!r || !r.ok) { $('sessnote').textContent = 'Could not do that.'; return; }
      paintSessions('Cleared ' + aiCount(r.revoked, 'one time sign in') + '. ');
    });
  });
  paintSessions('');

  renderAdminItems();
  initInbox();
  initAi();
}

/* What the count is made of (0031). A session counts as a device only once it has been used
   again after signing in: the publish and request scripts, and a single visit, sign in once and
   never come back, and until 2026-09-18 the scripts left one behind on every run. Code holders
   are counted apart, by the code's name. */
function paintSessions(lead) {
  StudyAuth.admin.sessions().then(function (r) {
    if (!r || !r.ok) return;
    var mine = [], once = [], codes = [];
    r.sessions.forEach(function (s) {
      if (s.code) { codes.push(s); return; }
      var used = s.is_you || (s.last_seen && new Date(s.last_seen) - new Date(s.created_at) > 5 * 60 * 1000);
      (used ? mine : once).push(s);
    });
    var names = {};
    codes.forEach(function (s) { var k = s.code_label || 'a deleted code'; names[k] = (names[k] || 0) + 1; });
    var parts = [aiCount(mine.length, 'device') + ' you have come back to, this one included'];
    if (once.length) parts.push(aiCount(once.length, 'one time sign in') + ' (script runs and single visits, safe to clear)');
    if (codes.length) parts.push(Object.keys(names).map(function (k) { return k + ' on ' + aiCount(names[k], 'device'); }).join(', ') + ' with an access code');
    $('sessnote').textContent = lead + parts.join('; ') + '.';
    $('revokestale').hidden = !once.length;
  });
}

/* ============================================================ offline cache */

function applyUpdate(worker) {
  worker.postMessage({ type: 'SKIP_WAITING' });
}

/* The switch is site-wide rather than per material, because it is one decision about your
   own data and it would be strange to have to make it separately in each quiz. The chemistry
   settings page shows the same switch bound to the same key. */
function initTelemetry() {
  var box = $('telon'), state = $('telstate'), note = $('telnote');
  if (!box || !window.StudyStore || !StudyStore.telemetry) return;
  function paint() {
    var on = StudyStore.telemetry.enabled();
    box.checked = on;
    state.textContent = on ? 'On' : 'Off';
    if (!on) { note.textContent = 'Off. Nothing is logged, and anything still waiting has been discarded.'; return; }
    var q = StudyStore.telemetry.pending();
    var stuck = StudyStore.telemetry.unavailable && StudyStore.telemetry.unavailable();
    note.textContent = stuck
      ? 'The server is not accepting review logs yet (run 0004_telemetry.sql in Supabase). ' +
        q + ' review' + (q === 1 ? '' : 's') + ' waiting on this device.'
      : q
        ? q + ' review' + (q === 1 ? '' : 's') + ' queued to send.'
        : 'Nothing waiting to send.';
  }
  box.addEventListener('change', function () {
    StudyStore.telemetry.setEnabled(box.checked);
    paint();
  });
  paint();
  setInterval(paint, 20000);
}

function initSW() {
  var note = $('swnote'), updateBtn = $('doupdate');

  $('clearcache').addEventListener('click', function () {
    var self = this;
    self.disabled = true; self.textContent = 'Clearing…';
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }).catch(function () {}).then(function () {
      return navigator.serviceWorker ? navigator.serviceWorker.getRegistration() : null;
    }).then(function (reg) { return reg ? reg.unregister() : null; })
      .catch(function () {}).then(function () { location.reload(); });
  });

  if (!('serviceWorker' in navigator)) {
    note.textContent = 'This browser will not keep an offline copy.';
    return;
  }

  /* sync.js has just called register(); on a first visit that has not finished, and
     getRegistration() would answer "no offline copy yet" while one was being made. ready
     resolves once a worker is active. If nothing is active within a few seconds
     (registration refused, or a browser that blocks it) say so instead of waiting forever. */
  var ready = navigator.serviceWorker.ready.then(function (reg) { return reg; });
  var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 8000); });
  Promise.race([ready, timeout]).then(function (reg) {
    if (!reg) { note.textContent = 'No offline copy yet. Reload once while online.'; return; }
    note.textContent = 'The hub and the materials you have opened work offline.';

    var offer = function (worker) {
      if (!worker) return;
      note.textContent = 'A newer version is ready.';
      updateBtn.hidden = false;
      updateBtn.onclick = function () {
        updateBtn.disabled = true; updateBtn.textContent = 'Updating…';
        applyUpdate(worker);
      };
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', function () {
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', function () {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
      });
    });
  }).catch(function () { note.textContent = 'Could not check the offline copy.'; });
}

/* ============================================================ boot */

function boot() {
  if (window.StudyStore) { try { StudyStore.init({ namespace: 'hub' }); } catch (e) {} }
  initSyncPanel();
  initSW();
  initTelemetry();
  /* Route at once: settings must open even when the catalog never arrives (offline, first visit). */
  handleHash();

  loadCatalog().then(function () {
    $('err').hidden = true;
    /* The catalog call is also the server's word on this session: it drops the stored
       role when the token is gone or lapsed. Repaint so the owner chip and the admin
       panel follow the verdict rather than whatever was in storage at boot. */
    paintOwner();
    renderAll('');
    renderRecents();
    initAdmin();
    handleHash();
  }).catch(function () {
    showError('Could not load the material list',
      'The server could not be reached and this device has no saved copy yet. Try again once you are online.');
  });

  var filter = $('filter'), t = null;
  filter.addEventListener('input', function () {
    clearTimeout(t);
    t = setTimeout(function () { renderAll(filter.value.trim().toLowerCase()); }, 90);
  });
  window.addEventListener('hashchange', handleHash);

  /* A lock or hide flipped on another device, or a newly published material, should show
     up when the tab is looked at again, not only after a reload. Floored at a minute so
     flicking between apps does not hammer the catalog. */
  var lastCatalog = Date.now();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCatalog < 60000) return;
    lastCatalog = Date.now();
    loadCatalog().then(function () {
      renderAll(filter.value.trim().toLowerCase());
      renderRecents();
      if (StudyAuth.isAdmin()) renderAdminItems();
    }).catch(function () {});
  });
}

function start() {
  initOwner();
  paintOwner();
  boot();
  initAsk();
  // Confirm an owner session in the background; a lapsed one just drops the controls.
  if (StudyAuth.signedIn()) {
    StudyAuth.verify().then(function (r) {
      if (!r) { paintOwner(); renderAll($('filter').value.trim().toLowerCase()); }
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

/* ============================================================================
 * Minimal QR encoder: byte mode, error correction level L, versions 1-10.
 * Enough for a hub URL plus a pairing code. Written for this file so the hub has
 * no external dependency and works offline.
 * ========================================================================== */

var EC_PER_BLOCK = { 1:7, 2:10, 3:15, 4:20, 5:26, 6:18, 7:20, 8:24, 9:30, 10:18 };
var NUM_BLOCKS   = { 1:1, 2:1, 3:1, 4:1, 5:1, 6:2, 7:2, 8:2, 9:2, 10:4 };
var TOTAL_CW     = { 1:26, 2:44, 3:70, 4:100, 5:134, 6:172, 7:196, 8:242, 9:292, 10:346 };
var ALIGN_POS    = {
  1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30],
  6:[6,34], 7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50]
};

var GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(function initGF() {
  var x = 1;
  for (var i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree) {
  var poly = [1];
  for (var i = 0; i < degree; i++) {
    var next = new Array(poly.length + 1).fill(0);
    for (var j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  var gen = rsGenerator(ecLen);
  var rem = new Array(ecLen).fill(0);
  for (var i = 0; i < data.length; i++) {
    var factor = data[i] ^ rem[0];
    rem.shift();
    rem.push(0);
    for (var j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], factor);
  }
  return rem;
}

function bchFormat(bits) {          // BCH(15,5), generator 0x537
  var d = bits << 10;
  for (var i = 4; i >= 0; i--) if (d & (1 << (i + 10))) d ^= 0x537 << i;
  return ((bits << 10) | d) ^ 0x5412;
}
function bchVersion(v) {            // BCH(18,6), generator 0x1F25
  var d = v << 12;
  for (var i = 5; i >= 0; i--) if (d & (1 << (i + 12))) d ^= 0x1F25 << i;
  return (v << 12) | d;
}

function buildQR(text) {
  var bytes = Array.from(new TextEncoder().encode(text));

  var version = 0;
  for (var v = 1; v <= 10; v++) {
    var lenBits = v < 10 ? 8 : 16;
    var capacity = (TOTAL_CW[v] - EC_PER_BLOCK[v] * NUM_BLOCKS[v]) * 8;
    if (4 + lenBits + bytes.length * 8 <= capacity) { version = v; break; }
  }
  if (!version) throw new Error('too much data for this QR encoder');

  var size = version * 4 + 17;
  var totalCw = TOTAL_CW[version];
  var ecLen = EC_PER_BLOCK[version];
  var blocks = NUM_BLOCKS[version];
  var dataCw = totalCw - ecLen * blocks;

  // ---- bit stream
  var bits = [];
  var push = function (val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4);                                   // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach(function (b) { push(b, 8); });
  for (var t = 0; t < 4 && bits.length < dataCw * 8; t++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  var padBytes = [0xEC, 0x11], pi = 0;
  var words = [];
  for (var i = 0; i < bits.length; i += 8) {
    var byte = 0;
    for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[i + k];
    words.push(byte);
  }
  while (words.length < dataCw) words.push(padBytes[pi++ % 2]);

  // ---- split into blocks, RS per block, interleave
  var short = Math.floor(dataCw / blocks);
  var longCount = dataCw % blocks;              // this many blocks carry one extra codeword
  var dataBlocks = [], ecBlocks = [], offset = 0;
  for (var b = 0; b < blocks; b++) {
    var len = short + (b >= blocks - longCount ? 1 : 0);
    var blk = words.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecLen));
  }
  var final = [];
  var maxLen = Math.max.apply(null, dataBlocks.map(function (d) { return d.length; }));
  for (var c = 0; c < maxLen; c++) {
    for (var bi = 0; bi < blocks; bi++) if (c < dataBlocks[bi].length) final.push(dataBlocks[bi][c]);
  }
  for (var e = 0; e < ecLen; e++) {
    for (var bj = 0; bj < blocks; bj++) final.push(ecBlocks[bj][e]);
  }

  // ---- matrix
  var mod = [], fn = [];
  for (var r = 0; r < size; r++) { mod.push(new Array(size).fill(0)); fn.push(new Array(size).fill(0)); }
  var setF = function (x, y, dark) { mod[y][x] = dark ? 1 : 0; fn[y][x] = 1; };

  var finder = function (cx, cy) {
    for (var dy = -1; dy <= 7; dy++) for (var dx = -1; dx <= 7; dx++) {
      var x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      var d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      setF(x, y, d !== 2 && d <= 3);
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

  for (var i2 = 8; i2 < size - 8; i2++) { setF(i2, 6, i2 % 2 === 0); setF(6, i2, i2 % 2 === 0); }

  var ap = ALIGN_POS[version];
  ap.forEach(function (ax) {
    ap.forEach(function (ay) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) return;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
        setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });

  setF(8, size - 8, true);   // dark module

  for (var f = 0; f <= 8; f++) {                     // reserve both format-info copies
    if (f !== 6) { fn[8][f] = 1; fn[f][8] = 1; }
  }
  for (var f2 = 0; f2 < 8; f2++) {
    fn[size - 1 - f2][8] = 1;
    fn[8][size - 1 - f2] = 1;
  }
  if (version >= 7) {
    for (var vb = 0; vb < 18; vb++) {
      var va = Math.floor(vb / 3), vc = size - 11 + (vb % 3);
      fn[vc][va] = 1; fn[va][vc] = 1;
    }
  }

  // ---- place data, zig-zag from bottom right
  var bitIdx = 0;
  var totalBits = final.length * 8;
  var getBit = function (n) { return n < totalBits ? (final[n >> 3] >> (7 - (n & 7))) & 1 : 0; };
  for (var col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (var row = 0; row < size; row++) {
      for (var s = 0; s < 2; s++) {
        var xx = col - s;
        var upward = ((col + 1) & 2) === 0;
        var yy = upward ? size - 1 - row : row;
        if (fn[yy][xx]) continue;
        mod[yy][xx] = getBit(bitIdx++);
      }
    }
  }

  // ---- masking
  var maskFns = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x, y) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; },
    function (x, y) { return (x * y) % 2 + (x * y) % 3 === 0; },
    function (x, y) { return ((x * y) % 2 + (x * y) % 3) % 2 === 0; },
    function (x, y) { return ((x + y) % 2 + (x * y) % 3) % 2 === 0; }
  ];

  function drawFormat(maskId, grid) {
    var bitsF = bchFormat((0x01 << 3) | maskId);   // 0b01 = ECC level L
    var bit = function (i) { return (bitsF >> i) & 1; };
    for (var i = 0; i <= 5; i++) grid[i][8] = bit(i);
    grid[7][8] = bit(6);
    grid[8][8] = bit(7);
    grid[8][7] = bit(8);
    for (var j = 9; j < 15; j++) grid[8][14 - j] = bit(j);
    for (var k = 0; k < 8; k++) grid[8][size - 1 - k] = bit(k);
    for (var m = 8; m < 15; m++) grid[size - 15 + m][8] = bit(m);
    grid[size - 8][8] = 1;
  }

  function drawVersion(grid) {
    if (version < 7) return;
    var bitsV = bchVersion(version);
    for (var i = 0; i < 18; i++) {
      var bit = (bitsV >> i) & 1;
      var a = Math.floor(i / 3), bb = size - 11 + (i % 3);
      grid[bb][a] = bit;
      grid[a][bb] = bit;
    }
  }

  function penalty(grid) {
    var score = 0, i, j, run, dark = 0;
    for (i = 0; i < size; i++) {
      run = 1;
      for (j = 1; j < size; j++) {
        if (grid[i][j] === grid[i][j - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
      run = 1;
      for (j = 1; j < size; j++) {
        if (grid[j][i] === grid[j - 1][i]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) {
      var c = grid[i][j];
      if (c === grid[i][j + 1] && c === grid[i + 1][j] && c === grid[i + 1][j + 1]) score += 3;
    }
    var pat1 = [1,0,1,1,1,0,1,0,0,0,0], pat2 = [0,0,0,0,1,0,1,1,1,0,1];
    var check = function (line) {
      for (var s = 0; s + 11 <= size; s++) {
        var m1 = true, m2 = true;
        for (var t2 = 0; t2 < 11; t2++) {
          if (line[s + t2] !== pat1[t2]) m1 = false;
          if (line[s + t2] !== pat2[t2]) m2 = false;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }
    };
    for (i = 0; i < size; i++) {
      check(grid[i]);
      var colArr = [];
      for (j = 0; j < size; j++) colArr.push(grid[j][i]);
      check(colArr);
    }
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (grid[i][j]) dark++;
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  var best = null, bestScore = Infinity;
  for (var mk = 0; mk < 8; mk++) {
    var grid = mod.map(function (row) { return row.slice(); });
    for (var y2 = 0; y2 < size; y2++) for (var x2 = 0; x2 < size; x2++) {
      if (!fn[y2][x2] && maskFns[mk](x2, y2)) grid[y2][x2] ^= 1;
    }
    drawFormat(mk, grid);
    drawVersion(grid);
    var sc = penalty(grid);
    if (sc < bestScore) { bestScore = sc; best = grid; }
  }
  return best;
}

function renderQR(text, el) {
  el.innerHTML = '';
  var grid;
  try { grid = buildQR(text); }
  catch (e) {
    var p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Could not draw the square. Use the code above instead.';
    el.appendChild(p);
    return;
  }
  var n = grid.length, quiet = 4, dim = n + quiet * 2;
  var d = '';
  for (var y = 0; y < n; y++) {
    var x = 0;
    while (x < n) {
      if (!grid[y][x]) { x++; continue; }
      var start = x;
      while (x < n && grid[y][x]) x++;
      d += 'M' + (start + quiet) + ' ' + (y + quiet) + 'h' + (x - start) + 'v1h-' + (x - start) + 'z';
    }
  }
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + dim + ' ' + dim);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Pairing code as a scannable square');
  var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', dim); bg.setAttribute('height', dim); bg.setAttribute('fill', '#fff');
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#17242A');
  svg.appendChild(bg);
  svg.appendChild(path);
  el.appendChild(svg);
}

/* ============================================================================
 * Ask for a material: a quiet request channel with no label saying who reads it.
 * The button and the sheet exist for every visitor; the Inbox list at the bottom
 * is admin only.
 * ========================================================================== */

var ASK_SB_URL = 'https://gyfqhkhgosjpyvatffbi.supabase.co';
var ASK_SB_KEY = 'sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb';

function askRpc(fn, body) {
  return fetch(ASK_SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: ASK_SB_KEY,
      Authorization: 'Bearer ' + ASK_SB_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  }).then(function (r) {
    if (r.ok) return r.json();
    return r.text().then(function (t) {
      var e = new Error('http_' + r.status);
      e.status = r.status;
      e.body = t;
      throw e;
    });
  });
}

var ASK_FEATURES = [
  'Study guide', 'Endless practice feed', 'Mock quiz or test', 'Notecards',
  'Multiple choice', 'True or false', 'Written short answers',
  'Worked problems with fresh numbers', 'Vocabulary drill', 'Printable sheet'
];

var ASK_ERR_TEXT = {
  empty: 'Add a subject or a note before sending.',
  rate_limited: 'Too many requests from this network right now. Try again later.',
  not_found: 'That request could not be found. Try again from the start.',
  not_open: 'That request is no longer open. Try again from the start.',
  expired: 'That took too long. Try again from the start.',
  too_many_files: 'Only 6 files per request.',
  file_too_large: 'That file is over 20 MB.',
  request_too_large: 'These files add up to more than 30 MB total.',
  storage_full: 'The inbox is full right now. Try again later, or leave files out.',
  out_of_order: 'That file lost its place while sending. Try sending it again.',
  chunk_too_large: 'That piece was too large.',
  bad_chunk: 'That piece could not be read. Try sending it again.',
  oversize: 'That file grew past what it said it would be.',
  forbidden: 'Not allowed.',
  bad_status: 'Not allowed.'
};

function askFriendlyError(err, fallback) {
  if (err && err.status === 404 && /PGRST202/.test(err.body || '')) return 'The inbox is not open yet.';
  if (err && err.error && ASK_ERR_TEXT[err.error]) return ASK_ERR_TEXT[err.error];
  if (err && err.message === 'rate_limited') return ASK_ERR_TEXT.rate_limited;
  return fallback || 'Could not reach the server. Nothing was lost, your form is still filled in.';
}

function buildAskGrid() {
  var grid = $('askgrid');
  grid.innerHTML = '';
  ASK_FEATURES.forEach(function (label) {
    var l = document.createElement('label');
    l.className = 'askchk';
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = label;
    l.appendChild(cb);
    l.appendChild(document.createTextNode(label));
    grid.appendChild(l);
  });

  var otherLabel = document.createElement('label');
  otherLabel.className = 'askchk';
  var otherCb = document.createElement('input');
  otherCb.type = 'checkbox'; otherCb.id = 'askotheron';
  otherLabel.appendChild(otherCb);
  otherLabel.appendChild(document.createTextNode('Other'));
  grid.appendChild(otherLabel);

  var otherInput = document.createElement('input');
  otherInput.type = 'text'; otherInput.className = 'askother'; otherInput.id = 'askothertext';
  otherInput.placeholder = 'Say what it is';
  otherInput.hidden = true;
  grid.appendChild(otherInput);
  otherCb.addEventListener('change', function () { otherInput.hidden = !otherCb.checked; });
}

function collectAskFeatures() {
  var out = [];
  $('askgrid').querySelectorAll('input[type=checkbox]').forEach(function (cb) {
    if (cb.id === 'askotheron') return;
    if (cb.checked) out.push(cb.value);
  });
  var otherOn = $('askotheron');
  if (otherOn && otherOn.checked) {
    var t = $('askothertext').value.trim();
    out.push(t ? 'Other: ' + t : 'Other');
  }
  return out;
}

var askFiles = [];

function renderAskFileList() {
  var ul = $('askfilelist');
  ul.innerHTML = '';
  askFiles.forEach(function (f, idx) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.textContent = f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)';
    var rm = document.createElement('button');
    rm.type = 'button'; rm.textContent = 'Remove';
    rm.addEventListener('click', function () {
      askFiles.splice(idx, 1);
      renderAskFileList();
    });
    li.appendChild(span); li.appendChild(rm);
    ul.appendChild(li);
  });
}

function onAskFilesChosen(fileList) {
  var err = $('askfileerr');
  err.hidden = true;
  var incoming = Array.prototype.slice.call(fileList);
  var rejected = [];
  incoming.forEach(function (f) {
    if (f.size > 20 * 1024 * 1024) { rejected.push(f.name + ' is over 20 MB'); return; }
    if (askFiles.length >= 6) { rejected.push(f.name + ' was not added, the limit is 6 files'); return; }
    askFiles.push(f);
  });
  if (rejected.length) { err.textContent = rejected.join('. ') + '.'; err.hidden = false; }
  renderAskFileList();
  $('askfiles').value = ''; // so picking the same file again re-fires change
}

function resetAskForm() {
  ['asksubject', 'askpurpose', 'askdue', 'asknotes', 'askname'].forEach(function (id) { $(id).value = ''; });
  askFiles = [];
  renderAskFileList();
  buildAskGrid();
  $('askerr').hidden = true;
  $('askfileerr').hidden = true;
  $('askprogress').hidden = true;
  $('askdone').hidden = true;
  $('askactions').hidden = false;
  $('asksend').disabled = false;
  $('askcancel').disabled = false;
  ['asksubject', 'askpurpose', 'askdue', 'askfiles', 'askfilelist', 'askgrid', 'asknotes', 'askname'].forEach(function (id) {
    var el = $(id);
    if (el) el.hidden = false;
  });
  $('askbody').querySelectorAll('.lbl').forEach(function (el) { el.hidden = false; });
}

function openAskModal() {
  resetAskForm();
  var dlg = $('askmodal');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeAskModal() {
  var dlg = $('askmodal');
  if (dlg.open) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }
}

function bufToBase64(buf) {
  var bytes = new Uint8Array(buf), binary = '', step = 0x8000;
  for (var i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function askWithRetry(fn, tries) {
  tries = tries || 3;
  function attempt(n) {
    return fn().catch(function (err) {
      if (n >= tries || (err && err.status === 404)) throw err;
      return attempt(n + 1);
    });
  }
  return attempt(1);
}

function paintAskProgress(text, pct) {
  $('askprogress').hidden = false;
  $('askprogresstext').textContent = text;
  $('askprogressfill').style.width = pct + '%';
}

function sendOneAskFile(file, fi, total, requestId) {
  return askRpc('request_file_open', {
    p_request: requestId, p_name: file.name,
    p_mime: file.type || 'application/octet-stream', p_size: file.size
  }).then(function (r) {
    if (!r || !r.ok) { var e = new Error('file_open_failed'); e.error = r && r.error; throw e; }
    return file.arrayBuffer().then(function (buf) {
      var slice = 1024 * 1024;
      var n = Math.max(1, Math.ceil(buf.byteLength / slice));
      var chain = Promise.resolve();
      var _loop = function (idx) {
        chain = chain.then(function () {
          var part = buf.slice(idx * slice, Math.min(buf.byteLength, (idx + 1) * slice));
          var pct = Math.round(((idx + 1) / n) * 100);
          paintAskProgress('Sending ' + (fi + 1) + ' of ' + total + ' files, ' + pct + '%', pct);
          return askWithRetry(function () {
            return askRpc('request_file_chunk', { p_file: r.file_id, p_index: idx, p_b64: bufToBase64(part) })
              .then(function (cr) {
                if (!cr || !cr.ok) { var e2 = new Error('chunk_failed'); e2.error = cr && cr.error; throw e2; }
              });
          });
        });
      };
      for (var i = 0; i < n; i++) _loop(i);
      return chain;
    });
  });
}

function sendAskFiles(requestId) {
  var total = askFiles.length;
  if (!total) return Promise.resolve(requestId);
  var chain = Promise.resolve();
  askFiles.forEach(function (file, fi) {
    chain = chain.then(function () { return sendOneAskFile(file, fi, total, requestId); });
  });
  return chain.then(function () { return requestId; });
}

function sendAskRequest() {
  var subject = $('asksubject').value.trim();
  var notes = $('asknotes').value.trim();
  var errEl = $('askerr');
  errEl.hidden = true;
  if (!subject && !notes) {
    errEl.textContent = ASK_ERR_TEXT.empty; errEl.hidden = false; return;
  }

  var meta = {
    subject: subject,
    purpose: $('askpurpose').value.trim(),
    due: $('askdue').value,
    notes: notes,
    from_name: $('askname').value.trim(),
    features: collectAskFeatures()
  };

  $('asksend').disabled = true; $('askcancel').disabled = true;

  askRpc('request_open', { p_meta: meta }).then(function (r) {
    if (!r || !r.ok) { var e = new Error('open_failed'); e.error = r && r.error; throw e; }
    return sendAskFiles(r.id);
  }).then(function (requestId) {
    return askRpc('request_finish', { p_request: requestId });
  }).then(function (r) {
    if (!r || !r.ok) { var e = new Error('finish_failed'); e.error = r && r.error; throw e; }
    $('askprogress').hidden = true;
    $('askactions').hidden = true;
    ['asksubject', 'askpurpose', 'askdue', 'askfiles', 'askfilelist', 'askgrid', 'asknotes', 'askname'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });
    $('askbody').querySelectorAll('.lbl').forEach(function (el) { el.hidden = true; });
    $('askdone').hidden = false;
    $('askdonetext').textContent = 'Sent. Reference ' + r.ref.toUpperCase() + '.';
  }).catch(function (err) {
    errEl.textContent = askFriendlyError(err);
    errEl.hidden = false;
  }).then(function () {
    $('asksend').disabled = false; $('askcancel').disabled = false;
  });
}

function initAsk() {
  buildAskGrid();
  $('asktrigger').addEventListener('click', openAskModal);
  $('askclose').addEventListener('click', closeAskModal);
  $('askcancel').addEventListener('click', closeAskModal);
  $('askdoneclose').addEventListener('click', closeAskModal);
  $('askfiles').addEventListener('change', function () { onAskFilesChosen(this.files); });
  $('asksend').addEventListener('click', sendAskRequest);
}

/* ---- admin inbox ---- */

var inboxShowAll = false;

function renderInboxRequest(req) {
  var row = document.createElement('div');
  row.className = 'inboxrow';

  var h = document.createElement('h4');
  h.textContent = req.subject || '(no subject)';
  row.appendChild(h);

  var meta = document.createElement('p');
  meta.className = 'inboxmeta';
  var when = req.created_at ? new Date(req.created_at).toLocaleString() : '';
  var bits = [when, req.purpose, req.due ? 'due ' + req.due : null,
    (req.features && req.features.length) ? req.features.join(', ') : null]
    .filter(function (x) { return !!x; });
  meta.textContent = bits.join(' | ');
  row.appendChild(meta);

  if (req.notes) {
    var p = document.createElement('p');
    p.className = 'inboxnotes'; p.textContent = req.notes;
    row.appendChild(p);
  }

  if (req.files && req.files.length) {
    var ul = document.createElement('ul');
    ul.className = 'inboxfiles';
    req.files.forEach(function (f) {
      var li = document.createElement('li');
      li.textContent = (f.purged ? '(removed) ' : '') + f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)';
      ul.appendChild(li);
    });
    row.appendChild(ul);
  }

  var actions = document.createElement('div');
  actions.className = 'row wrap';
  var seenBtn = document.createElement('button');
  seenBtn.type = 'button'; seenBtn.className = 'btn ghost sm';
  var already = req.status === 'seen' || req.status === 'done';
  seenBtn.textContent = already ? 'Seen' : 'Mark seen';
  seenBtn.disabled = already;
  seenBtn.addEventListener('click', function () {
    seenBtn.disabled = true;
    askRpc('admin_request_mark', { p_token: StudyAuth.token(), p_id: req.id, p_status: 'seen' })
      .then(function (r) {
        if (r && r.ok) { seenBtn.textContent = 'Seen'; }
        else { seenBtn.disabled = false; }
      }, function () { seenBtn.disabled = false; });
  });
  actions.appendChild(seenBtn);
  row.appendChild(actions);

  return row;
}

function loadInbox() {
  var note = $('inboxnote'), list = $('inboxlist');
  askRpc('admin_requests', { p_token: StudyAuth.token(), p_all: inboxShowAll }).then(function (r) {
    if (!r || !r.ok) {
      note.textContent = r && r.error === 'forbidden' ? 'Not allowed.' : 'Could not load the inbox.';
      list.innerHTML = '';
      return;
    }
    note.textContent = r.requests.length ? '' : 'No requests yet.';
    list.innerHTML = '';
    r.requests.forEach(function (req) { list.appendChild(renderInboxRequest(req)); });
  }, function (err) {
    note.textContent = (err && err.status === 404 && /PGRST202/.test(err.body || ''))
      ? 'Run 0007_requests.sql in Supabase to open the inbox.'
      : 'Could not load the inbox.';
    list.innerHTML = '';
  });
}

function initInbox() {
  $('inboxshowall').addEventListener('click', function () {
    inboxShowAll = !inboxShowAll;
    this.setAttribute('aria-pressed', String(inboxShowAll));
    this.textContent = inboxShowAll ? 'Show submitted only' : 'Show all';
    loadInbox();
  });
  loadInbox();
}

})();
