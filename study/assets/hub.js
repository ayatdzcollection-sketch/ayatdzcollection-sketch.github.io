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
  $('ownersum').textContent = admin ? 'signed in' : 'signed out';
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
  var li = document.createElement('li');
  var a = document.createElement('button');
  a.type = 'button';
  a.className = 'mrow' + (lockedForMe ? ' islocked' : '') + (isRetired(m) ? ' isretired' : '');

  var left = document.createElement('span');
  left.className = 'mleft';
  var title = document.createElement('span');
  title.className = 'mtitle';
  title.textContent = m.title;
  if (m.locked) title.appendChild(flag('locked', 'Locked'));
  if (m.hidden) title.appendChild(flag('hidden', 'Hidden'));
  if (isRetired(m)) title.appendChild(flag('retired', 'Retired'));
  /* The owner's reminder of which materials offer an AI feature. Nothing AI related is drawn
     for anyone else. */
  if (StudyAuth.isAdmin() && aiHasAnyTag(m)) title.appendChild(flag('ai', 'AI'));
  left.appendChild(title);
  if (m.blurb) {
    var b = document.createElement('span');
    b.className = 'mblurb'; b.textContent = m.blurb;
    left.appendChild(b);
  }

  var right = document.createElement('span');
  right.className = 'mright';
  if (m.added) {
    var ad = document.createElement('span');
    ad.className = 'madded'; ad.textContent = m.added;
    right.appendChild(ad);
  }

  a.appendChild(left); a.appendChild(right);
  a.addEventListener('click', function () { open(m); });
  li.appendChild(a);
  return li;
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
    head.className = 'khead';
    var h2 = document.createElement('h2');
    h2.className = 'kname';
    h2.textContent = klass.name;
    head.appendChild(h2);
    if (klass.term) {
      var t = document.createElement('span');
      t.className = 'kterm'; t.textContent = klass.term;
      head.appendChild(t);
    }
    sec.appendChild(head);

    var ul = document.createElement('ul');
    ul.className = 'rows';

    mats.forEach(function (m) {
      if (isRetired(m)) { retired.push(m); shown++; return; }
      ul.appendChild(makeRow(m));
      shown++;
    });

    if (ul.children.length) { sec.appendChild(ul); wrap.appendChild(sec); }
  });

  /* Retired things stay openable (an old quiz's material is still a good review) but sit
     under one collapsed heading at the bottom, out of the way of what is current. */
  if (retired.length) {
    var det = document.createElement('details');
    det.className = 'retiredwrap';
    det.open = !!needle;
    var sum = document.createElement('summary');
    sum.innerHTML = '<span class="kname">Retired</span><span class="kterm"></span>';
    sum.lastChild.textContent = retired.length + ' from earlier quizzes and assignments';
    det.appendChild(sum);
    var rul = document.createElement('ul');
    rul.className = 'rows';
    retired.forEach(function (m) { rul.appendChild(makeRow(m)); });
    det.appendChild(rul);
    wrap.appendChild(det);
  }

  $('noresults').hidden = shown > 0;
  var n = items.length;
  var classes = groupByClass(items).length;
  $('subline').textContent = n
    ? n + ' material' + (n === 1 ? '' : 's') + ' across ' + classes + ' class' + (classes === 1 ? '' : 'es') + '.'
    : 'No materials yet.';
}

function flag(cls, text) {
  var s = document.createElement('span');
  s.className = 'flag ' + cls;
  s.textContent = text;
  return s;
}

function open(m) {
  if (m.locked && !StudyAuth.isAdmin()) {
    $('ownerpanel').open = true;
    $('ownerpanel').scrollIntoView({ block: 'center' });
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
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip';
      b.textContent = r.title || r.id;
      b.addEventListener('click', function () { open(known[r.id]); });
      box.appendChild(b);
    });
    $('recentwrap').hidden = !box.children.length;
  });
}

/* ============================================================ hash route */

function handleHash() {
  var h = (location.hash || '').replace(/^#/, '');
  if (!h) return;

  if (h.indexOf('pair=') === 0) {
    var code = decodeURIComponent(h.slice(5));
    $('syncpanel').open = true;
    $('paircode').value = code;
    $('syncpanel').scrollIntoView({ block: 'start' });
    if (window.confirm('Pair this device with code ' + code + '?')) doPair();
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  var el = document.getElementById(h);
  if (el) {
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
            'The AI features this code carries are on: highlight text in a material and tap Ask, or press Alt and A.');
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
  if (strip) strip.addEventListener('click', function () {
    var panel = $('syncpanel');
    panel.open = true;
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

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
  var total = AI_FEATURES.length;
  var wrap = el('div', 'aipop');
  var btn = el('button', 'tog aipopbtn');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  var menu = el('div', 'aipopmenu');
  menu.id = 'aipop-' + i;
  menu.hidden = true;
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'AI features for ' + (m.title || m.id));
  btn.setAttribute('aria-controls', menu.id);

  var err = el('p', 'err-inline aipoperr');
  err.hidden = true;
  var boxes = [];

  function paintBtn() {
    var n = AI_FEATURES.filter(function (f) { return hasTag(m, f.tag); }).length;
    btn.textContent = 'AI ' + n + '/' + total;
    btn.setAttribute('aria-label', 'AI features, ' + n + ' of ' + total + ' on');
    btn.classList.toggle('some', n > 0);
  }

  function settle(box, on, text) {
    boxes.forEach(function (b) { b.disabled = false; });
    if (text == null) return;
    box.checked = !on;
    err.textContent = text;
    err.hidden = false;
  }

  AI_FEATURES.forEach(function (f) {
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

   The section is five groups that stay closed until opened, so it does not grow a screen
   longer each time a feature is added: Spend (the master switch and the ceilings every
   feature spends against), Features (one row each), Models (what the eval measured),
   Recent calls (the ledger) and Chats (saved Ask conversations, rated and exported). */

/* Every AI feature, one line each. id is the feature's id on the server, tag is what a
   material carries to offer it, label is what the per material control reads. 'saq' has no
   row in study_ai_features: its mode and model live in study_ai_settings (0010). A third
   feature is one line here and one row in study_ai_features. */
var AI_FEATURES = [
  { id: 'saq', tag: 'ai',     label: 'SAQ grading', short: 'SAQ' },
  { id: 'ask', tag: 'ai-ask', label: 'Ask (beta)',  short: 'Ask' }
];

function aiFeatureInfo(id) {
  var hit = null;
  AI_FEATURES.forEach(function (f) { if (f.id === id) hit = f; });
  return hit;
}

function aiHasAnyTag(m) {
  return AI_FEATURES.some(function (f) { return hasTag(m, f.tag); });
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

/* Chats: twenty to a page on screen; an export asks for the server's largest page and stops
   after twenty of them, ten thousand chats, rather than looping on a server that misbehaves. */
var AI_CHATS_PAGE = 20;
var AI_CHATS_EXPORT_PAGE = 500;
var AI_CHATS_EXPORT_PAGES = 20;

var aiEl = null;
var aiState = { settings: null, models: [], usage: null, features: [], saq: null, featErr: '',
  passes: [], passFeatures: [], passNow: null, passErr: '', passSkew: 0, passNew: null,
  tickets: [], ticketStats: null, ticketErr: '', ticketOpenOnly: true };
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
  if (control.tagName === 'INPUT' || control.tagName === 'SELECT') {
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

function buildAi(sec) {
  var e = { cap: {}, rows: Object.create(null) };

  var head = el('div', 'aihead');
  head.appendChild(el('h3', 'rubric', 'AI'));
  e.refresh = el('button', 'ailink', 'Refresh');
  e.refresh.type = 'button';
  head.appendChild(e.refresh);
  sec.appendChild(head);
  sec.appendChild(el('p', 'note',
    'Every feature is off until you turn it on, spends against the caps in Spend, and runs ' +
    'only in a material that carries its tag (the AI button on each row above). What a ' +
    'student types goes to Anthropic for the answer. The ledger keeps no text; Ask saves its ' +
    'questions and answers, and they are in Chats.'));

  e.msg = el('p', 'err-inline');
  e.msg.hidden = true;
  sec.appendChild(e.msg);

  e.body = el('div', 'aigroups');
  sec.appendChild(e.body);

  /* ---- Spend ---- */
  e.spend = aiGroup(e.body, 'spend', 'Spend');
  var master = el('div', 'aimaster');
  var mt = el('div', 'aimastertext');
  mt.appendChild(el('span', 'aimastername', 'All AI features'));
  mt.appendChild(el('span', 'aimeta', 'Off holds every feature, whatever its own switch says.'));
  master.appendChild(mt);
  e.master = aiSwitch('All AI features');
  master.appendChild(e.master);
  e.spend.body.appendChild(master);
  e.masterErr = el('p', 'err-inline');
  e.masterErr.hidden = true;
  e.spend.body.appendChild(e.masterErr);

  e.readout = el('p', 'aireadout');
  e.spend.body.appendChild(e.readout);

  e.caps = el('div', 'aicaps');
  AI_FIELDS.forEach(function (f) {
    var inp = aiTextInput();
    var fld = aiField('aicap', f.label + (f.money ? ' (dollars)' : ''), inp);
    e.cap[f.key] = { input: inp, err: fld.err };
    e.caps.appendChild(fld.field);
  });
  e.spend.body.appendChild(e.caps);

  /* Today only (0016). It is not one of the stored caps: it lifts the daily ceiling until the
     next day boundary and then lapses, so a cram night never quietly becomes the new normal. */
  e.bonus = aiTextInput();
  var bf = aiField('aibonus', 'Extra for today only (dollars)', e.bonus);
  e.bonusErr = bf.err;
  e.spend.body.appendChild(bf.field);
  e.spend.body.appendChild(el('p', 'note',
    'The daily and monthly caps count every feature in either mode, and each feature\'s own ' +
    'daily cap sits inside them. The device and address limits hold features set to Open with ' +
    'caps. The monthly cap is the one that cannot be talked around: a device id is spoofable, ' +
    'a spend ceiling is not.'));
  var saveRow = el('div', 'row wrap');
  e.save = el('button', 'btn sm', 'Save the caps');
  e.save.type = 'button';
  e.bonus.addEventListener('input', function () { e.bonus.setAttribute('data-editing', '1'); });
  e.bonus.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') e.bonus.blur(); });
  e.bonus.addEventListener('change', function () {
    e.bonus.removeAttribute('data-editing');
    e.bonusErr.hidden = true;
    var raw = e.bonus.value.trim().replace(/^\$/, '');
    var n = raw === '' ? 0 : Number(raw);
    if (!isFinite(n) || n < 0) { aiShowAt(e.bonusErr, 'Numbers only.'); return; }
    aiBonusSet(null, Math.round(n * 100), e.bonusErr);
  });
  e.saveMsg = el('span', 'aisaved');
  saveRow.appendChild(e.save);
  saveRow.appendChild(e.saveMsg);
  e.spend.body.appendChild(saveRow);

  /* ---- Features ---- */
  e.feat = aiGroup(e.body, 'features', 'Features');
  e.held = el('p', 'aiheld', 'All AI features is off in Spend, so nothing here can run.');
  e.held.hidden = true;
  e.feat.body.appendChild(e.held);
  e.featNote = el('p', 'err-inline');
  e.featNote.hidden = true;
  e.feat.body.appendChild(e.featNote);
  e.featList = el('ul', 'aifeats');
  e.feat.body.appendChild(e.featList);

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
  e.feat.body.appendChild(eff.field);
  e.feat.body.appendChild(el('p', 'note',
    'Owner only takes your admin session on every call and skips the device and address ' +
    'limits. Open with caps lets anyone studying use it, held by every cap in Spend.'));

  /* ---- Models ---- */
  /* ---- Codes ---- */
  e.passGroup = aiGroup(e.body, 'passes', 'Codes');
  e.passGroup.body.appendChild(el('p', 'note',
    'A code is one person: it saves their progress under that code and lets them use the AI ' +
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
  e.ticketGroup = aiGroup(e.body, 'tickets', 'Reports');
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

  e.modelsGroup = aiGroup(e.body, 'models', 'Models');
  /* The selects alone would make each choice blind. This list is the reason for the choice:
     what the eval measured, and what one grade costs at that model's prices. */
  e.models = el('div', 'aimodels');
  e.modelsGroup.body.appendChild(e.models);

  /* ---- Recent calls ---- */
  e.callsGroup = aiGroup(e.body, 'calls', 'Recent calls');
  e.calls = el('div', 'aicalls');
  e.callsGroup.body.appendChild(e.calls);

  /* ---- Chats ---- */
  /* Saved Ask conversations (0012), so the beta can be judged on what it actually said: the
     newest twenty, one line each until opened, a rating that saves as it is tapped, and an
     export of the lot. Every string in a row came from the server and goes in as text. */
  e.chatsGroup = aiGroup(e.body, 'chats', 'Chats');
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
   the section never throws away a cap someone is halfway through typing. */
function aiFeatRow(id) {
  var saq = id === 'saq';
  var r = { id: id, saq: saq };
  r.li = el('li', 'aifeat');

  var head = el('div', 'aifeathead');
  var who = el('div', 'aifeatwho');
  var title = el('div', 'aifeattitle');
  r.name = el('span', 'aifeatname');
  r.beta = el('span', 'aibeta', 'Beta');
  r.beta.hidden = true;
  title.appendChild(r.name);
  title.appendChild(r.beta);
  who.appendChild(title);
  r.meta = el('p', 'aifeatmeta');
  who.appendChild(r.meta);
  head.appendChild(who);
  if (saq) {
    /* SAQ grading predates the features table. Its only switch is the master one. */
    r.fixed = el('span', 'aifixed');
    head.appendChild(r.fixed);
  } else {
    r.sw = aiSwitch();
    head.appendChild(r.sw);
  }
  r.li.appendChild(head);

  var ctl = el('div', 'aifeatctl');
  var f;
  r.seg = aiSeg();
  f = aiField('aimode', 'Who can use it', r.seg.wrap);
  r.modeErr = f.err;
  ctl.appendChild(f.field);

  r.model = document.createElement('select');
  r.model.className = 'aisel';
  f = aiField('aimodelf', 'Model', r.model);
  r.modelErr = f.err;
  ctl.appendChild(f.field);

  if (saq) {
    r.capFixed = el('p', 'aifixedval');
    f = aiField('aicapf', 'Daily cap', r.capFixed);
  } else {
    r.cap = aiTextInput();
    f = aiField('aicapf', 'Daily cap ($)', r.cap);
    r.capErr = f.err;
  }
  ctl.appendChild(f.field);

  if (!saq) {
    r.bonus = aiTextInput();
    f = aiField('aibonusf', 'Extra today ($)', r.bonus);
    r.bonusErr = f.err;
    ctl.appendChild(f.field);
  }

  if (!saq) {
    /* Whether an answer may go past the material (0015). Hidden for a feature that has no such
       switch, so an older server without the column shows nothing rather than a dead control. */
    r.beyond = aiSwitch('Beyond the material');
    f = aiField('aibeyondf', 'Beyond the material', r.beyond);
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
  r.li.appendChild(ctl);

  r.msg = el('p', 'err-inline aifeatmsg');
  r.msg.hidden = true;
  r.li.appendChild(r.msg);

  aiWireRow(r);
  return r;
}

function aiRowControls(r) {
  return [r.sw, r.seg.owner, r.seg.open, r.model, r.cap, r.beyond, r.phone, r.bonus].filter(Boolean);
}

function aiRowClear(r) {
  [r.modeErr, r.modelErr, r.capErr, r.beyondErr, r.phoneErr, r.bonusErr, r.msg].forEach(function (n) {
    if (!n) return;
    n.hidden = true;
    n.textContent = '';
  });
}

function aiWireRow(r) {
  var set = r.saq
    ? function (patch) { return aiSet(patch, r); }
    : function (patch) { return aiFeatureSet(r, patch); };

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
  if (r.bonus) {
    r.bonus.addEventListener('input', function () { r.bonus.setAttribute('data-editing', '1'); });
    r.bonus.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') r.bonus.blur(); });
    r.bonus.addEventListener('change', function () {
      r.bonus.removeAttribute('data-editing');
      aiRowClear(r);
      var raw = r.bonus.value.trim().replace(/^\$/, '');
      var n = raw === '' ? 0 : Number(raw);
      if (!isFinite(n) || n < 0) { aiShowAt(r.bonusErr, 'Numbers only.'); return; }
      aiBonusSet(r.id, Math.round(n * 100), r.bonusErr, r);
    });
  }
  if (r.cap) {
    r.cap.addEventListener('input', function () { r.cap.setAttribute('data-editing', '1'); });
    r.cap.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') r.cap.blur(); });
    r.cap.addEventListener('change', function () {
      r.cap.removeAttribute('data-editing');
      aiRowClear(r);
      var raw = r.cap.value.trim().replace(/^\$/, '');
      if (raw === '') { paintAi(); return; }
      var n = Number(raw);
      if (!isFinite(n)) { aiShowAt(r.capErr, 'Numbers only.'); return; }
      set({ daily_cents: Math.round(n * 100) });
    });
  }
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
  /* Without 0011 the ledger has no feature column and every call in it is a grade. */
  var today = aiState.saq ? aiState.saq.today_cents : (aiState.usage ? aiState.usage.today_cents : 0);
  r.meta.textContent = 'Today ' + spendDollars(today) + ' · tag ' + info.tag;
  r.fixed.textContent = s.enabled ? 'On with All AI' : 'Off with All AI';
  r.li.classList.toggle('off', !s.enabled);
  aiPaintMode(r, s.mode);
  aiPaintModelSelect(r.model, s.model);
  r.capFixed.textContent = 'Global ' + dollars(s.daily_cents);
}

function aiPaintFeatRow(r, f, s) {
  var name = String(f.name || f.id);
  r.name.textContent = name;
  r.beta.hidden = !f.beta;
  r.sw.setAttribute('aria-checked', String(!!f.enabled));
  r.sw.setAttribute('aria-label', name);
  var bonus = Number(f.bonus_cents) || 0;
  r.meta.textContent = 'Today ' + spendDollars(f.today_cents) + ' of ' +
    dollars((Number(f.daily_cents) || 0) + bonus) + (bonus ? ' (' + dollars(bonus) + ' extra today)' : '') +
    ', ' + aiCount(f.today_calls, 'call') +
    (Number(f.codes_today_cents) > 0 ? ' · codes ' + spendDollars(f.codes_today_cents) + ' from their own money' : '') +
    ' · tag ' + String(f.tag || '');
  r.li.classList.toggle('off', !s.enabled || !f.enabled);
  aiPaintMode(r, f.mode);
  aiPaintModelSelect(r.model, f.model);
  if (r.beyond) {
    /* Trap notes never read the beyond switch, so their row does not offer it. */
    r.beyondField.hidden = typeof f.beyond !== 'boolean' || f.id === 'trap';
    r.beyond.setAttribute('aria-checked', String(!!f.beyond));
  }
  if (r.phone) {
    r.phoneField.hidden = typeof f.phone_button !== 'boolean' || f.id !== 'ask';
    r.phone.setAttribute('aria-checked', String(!!f.phone_button));
  }
  if (r.cap.getAttribute('data-editing') !== '1') {
    r.cap.value = f.daily_cents == null ? '' : (Number(f.daily_cents) / 100).toFixed(2);
  }
  if (r.bonus && r.bonus.getAttribute('data-editing') !== '1') {
    r.bonus.value = bonus ? (bonus / 100).toFixed(2) : '';
  }
}

function aiPaintFeatures() {
  var s = aiState.settings;
  var list = [{ id: 'saq' }].concat((aiState.features || []).filter(function (f) {
    return f && typeof f.id === 'string' && f.id !== 'saq';
  }));
  var keep = Object.create(null);
  list.forEach(function (f, i) {
    keep[f.id] = true;
    var r = aiEl.rows[f.id] || (aiEl.rows[f.id] = aiFeatRow(f.id));
    /* Moving a node that holds focus blurs it, so a row is only moved when it is out of place. */
    if (aiEl.featList.children[i] !== r.li) aiEl.featList.insertBefore(r.li, aiEl.featList.children[i] || null);
    if (r.saq) aiPaintSaqRow(r, s); else aiPaintFeatRow(r, f, s);
  });
  Object.keys(aiEl.rows).forEach(function (id) {
    if (keep[id]) return;
    var gone = aiEl.rows[id];
    if (gone.li.parentNode) gone.li.parentNode.removeChild(gone.li);
    delete aiEl.rows[id];
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

function aiPaintReadout() {
  var u = aiState.usage, s = aiState.settings;
  var bonus = aiBonusToday(s);
  if (aiEl.bonus && aiEl.bonus.getAttribute('data-editing') !== '1') {
    aiEl.bonus.value = bonus ? (bonus / 100).toFixed(2) : '';
  }
  aiEl.readout.innerHTML = '';
  if (!u) {
    aiEl.readout.textContent = aiState.usageErr ? 'Could not load the spending. Close and reopen the panel.' : 'Loading the spending.';
    return;
  }
  /* Two lines since 0026: what counts against the caps above, and what codes spent from the
     money loaded on them, which never counts against those caps and is never stopped by them. */
  aiEl.readout.appendChild(el('span', 'aireadline',
    'Your caps: today ' + spendDollars(u.today_cents) + ' of ' + dollars((s ? Number(s.daily_cents) || 0 : 0) + bonus) +
    (bonus ? ' (' + dollars(bonus) + ' extra today)' : '') + ', ' +
    aiCount(u.today_calls, 'call') + ' · month ' + spendDollars(u.month_cents) + ' of ' +
    dollars(s && s.monthly_cents) + ', ' + aiCount(u.month_calls, 'call')));
  if (u.codes_today_cents != null) {
    aiEl.readout.appendChild(el('span', 'aireadline',
      'Codes, from their own money: today ' + spendDollars(u.codes_today_cents) + ', ' +
      aiCount(u.codes_today_calls, 'call') + ' · month ' + spendDollars(u.codes_month_cents) + ', ' +
      aiCount(u.codes_month_calls, 'call') + '. Not counted in your caps.'));
  }
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

/* What each closed group says about itself. */
function aiPaintSummaries() {
  var s = aiState.settings, u = aiState.usage;
  if (s) {
    aiEl.spend.state.textContent = (s.enabled ? 'On' : 'Off') + ' · ' +
      (u ? shortDollars(u.today_cents) + ' today of ' : 'daily cap ') + dollars(s.daily_cents) +
      (u && Number(u.codes_today_cents) > 0 ? ' · codes ' + shortDollars(u.codes_today_cents) : '');
    var feats = (aiState.features || []).filter(function (f) { return f && f.id !== 'saq'; });
    var n = 1 + feats.length;
    var on = 1 + feats.filter(function (f) { return f.enabled; }).length;
    aiEl.feat.state.textContent = aiCount(n, 'feature') + ' · ' + (s.enabled ? on + ' on' : 'held off');
  }
  var ms = aiState.models;
  aiEl.modelsGroup.state.textContent = ms.length
    ? ms.length + ' listed · ' + ms.filter(function (m) { return m.enabled !== false; }).length + ' on'
    : 'none listed';
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
   merged over the one in hand so today's spend (not part of the reply) stays put. */
function aiFeatureSet(row, patch) {
  if (!aiEl) return Promise.resolve(null);
  var busy = aiRowControls(row);
  var body = { id: row.id };
  Object.keys(patch).forEach(function (k) { body[k] = patch[k]; });
  aiRowClear(row);
  aiDisable(busy, true);
  return StudyAuth.admin.ai.featureSet(body).then(function (r) {
    aiDisable(busy, false);
    if (r && r.ok && r.feature) { aiMergeFeature(r.feature); paintAi(); return r; }
    if (r && r.ok) return aiLoad().then(function () { return r; });
    var field = r && r.error === 'range' ? r.field : null;
    var at = field === 'mode' ? row.modeErr
      : field === 'model' ? row.modelErr
      : field === 'daily_cents' ? row.capErr
      : field === 'beyond' ? row.beyondErr
      : field === 'phone_button' ? row.phoneErr
      : null;
    if (at) aiShowAt(at, aiRangeText(field));
    else aiShowAt(row.msg, field ? aiRangeText(field) : aiRefusal(r));
    paintAi();
    return r;
  }, function (err) {
    aiDisable(busy, false);
    aiShowAt(row.msg, aiErrText(err));
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
  ['name', 'enabled', 'mode', 'model', 'daily_cents', 'tag', 'beta', 'beyond', 'phone_button', 'bonus_cents', 'updated_at'].forEach(function (k) {
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
    btn('End now', function () { return { id: p.id, when: 'now' }; }, 'End this code now? They lose the AI features straight away.');
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
       call in the reports loader once kept the spending from ever loading). */
    var usage = aiLoadUsage();
    [aiLoadPasses, aiLoadTickets].forEach(function (load) {
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
  if (c.status && c.status !== 'ok') meta.appendChild(el('span', 'aichip aibad', String(c.status)));
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

  AI_FIELDS.forEach(function (f) {
    var inp = e.cap[f.key].input;
    inp.addEventListener('input', function () {
      inp.setAttribute('data-editing', '1');
      e.saveMsg.textContent = '';
    });
  });

  e.save.addEventListener('click', function () {
    aiNote('');
    aiClearFieldErrors();
    e.saveMsg.textContent = '';
    var patch = {}, bad = false;
    AI_FIELDS.forEach(function (f) {
      var raw = e.cap[f.key].input.value.trim();
      if (raw === '') return;
      var n = Number(raw);
      if (!isFinite(n)) {
        aiShowAt(e.cap[f.key].err, 'Numbers only.');
        bad = true;
        return;
      }
      patch[f.key] = f.money ? Math.round(n * 100) : Math.round(n);
    });
    if (bad) return;
    AI_FIELDS.forEach(function (f) { e.cap[f.key].input.removeAttribute('data-editing'); });
    aiSet(patch, null, [e.save]).then(function (r) {
      if (r && r.ok) e.saveMsg.textContent = 'Saved.';
    });
  });

  e.refresh.addEventListener('click', function () { aiLoad(); });
}

function initAi() {
  if (!StudyAuth.isAdmin()) return;
  var sec = $('aiblock');
  if (!sec || !aiEl) {
    if (sec && sec.parentNode) sec.parentNode.removeChild(sec);
    var body = document.querySelector('#adminpanel .panelbody');
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
