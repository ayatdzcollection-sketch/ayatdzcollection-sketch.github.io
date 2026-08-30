/* Study Hub — manifest rendering, filtering, recents, and the sync panel. */
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var manifest = null;
var swRegistration = null;

/* ============================================================ manifest */

function ManifestError(msg, detail) {
  this.message = msg;
  this.detail = detail || '';
}

function loadManifest() {
  return fetch('materials.json', { cache: 'no-cache' }).then(function (res) {
    if (!res.ok) {
      throw new ManifestError(
        'Could not load materials.json (HTTP ' + res.status + ').',
        res.status === 404
          ? 'The file is missing from this folder. It sits next to index.html.'
          : 'The server refused the request.');
    }
    return res.text();
  }).then(function (text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new ManifestError('materials.json is not valid JSON.',
        e.message + ' — a stray comma or a missing quote will do this. Paste the file into a JSON checker to find the spot.');
    }
    if (!data || !Array.isArray(data.classes)) {
      throw new ManifestError('materials.json is missing its "classes" list.',
        'The file must look like { "classes": [ … ] }.');
    }
    return data;
  });
}

function showError(err) {
  var box = $('err');
  box.innerHTML = '';
  var h = document.createElement('h2');
  h.textContent = 'Something is wrong with the material list';
  var p = document.createElement('p');
  p.textContent = err.message || String(err);
  box.appendChild(h);
  box.appendChild(p);
  if (err.detail) {
    var d = document.createElement('p');
    d.textContent = err.detail;
    box.appendChild(d);
  }
  box.hidden = false;
}

/* ============================================================ rendering */

function safePath(p) {
  // Materials are always relative to this folder. Anything else is a mistake or worse.
  return typeof p === 'string' && p && !/^[a-z]+:/i.test(p) && p.charAt(0) !== '/' && p.indexOf('..') === -1;
}

function matches(material, klass, needle) {
  if (!needle) return true;
  var hay = [material.title, material.blurb, (material.tags || []).join(' '), klass.name, klass.id]
    .join(' ').toLowerCase();
  return needle.split(/\s+/).every(function (word) { return hay.indexOf(word) !== -1; });
}

function renderAll(needle) {
  var wrap = $('classes');
  wrap.innerHTML = '';
  var shown = 0;

  (manifest.classes || []).forEach(function (klass) {
    var mats = (klass.materials || []).filter(function (m) { return matches(m, klass, needle); });
    if (!mats.length) return;

    var sec = document.createElement('section');
    sec.className = 'klass';
    if (klass.id) sec.id = String(klass.id);

    var head = document.createElement('div');
    head.className = 'khead';
    var h2 = document.createElement('h2');
    h2.className = 'kname';
    h2.textContent = klass.name || klass.id || 'Untitled class';
    head.appendChild(h2);
    if (klass.term) {
      var term = document.createElement('span');
      term.className = 'kterm';
      term.textContent = klass.term;
      head.appendChild(term);
    }
    sec.appendChild(head);

    var ul = document.createElement('ul');
    ul.className = 'rows';

    mats.forEach(function (m) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'mrow';

      if (safePath(m.path)) {
        a.href = m.path;
      } else {
        a.href = '#';
        a.addEventListener('click', function (e) {
          e.preventDefault();
          showError(new ManifestError(
            'The entry "' + (m.title || m.id) + '" has an unusable path.',
            'Paths must point inside this folder, like "m/apush/fifty-states.html". Found: ' + String(m.path)));
        });
      }

      var left = document.createElement('span');
      left.className = 'mleft';
      var t = document.createElement('span');
      t.className = 'mtitle';
      t.textContent = m.title || m.id || 'Untitled';
      left.appendChild(t);
      if (m.blurb) {
        var b = document.createElement('span');
        b.className = 'mblurb';
        b.textContent = m.blurb;
        left.appendChild(b);
      }

      var right = document.createElement('span');
      right.className = 'mright';
      if (m.tags && m.tags.length) {
        var tg = document.createElement('span');
        tg.className = 'mtags';
        tg.textContent = m.tags.join(' · ');
        right.appendChild(tg);
      }
      if (m.added) {
        var ad = document.createElement('span');
        ad.className = 'madded';
        ad.textContent = m.added;
        right.appendChild(ad);
      }

      a.appendChild(left);
      a.appendChild(right);
      a.addEventListener('click', function () { recordRecent(m); });

      li.appendChild(a);
      ul.appendChild(li);
      shown++;
    });

    sec.appendChild(ul);
    wrap.appendChild(sec);
  });

  $('noresults').hidden = shown > 0;
  var total = (manifest.classes || []).reduce(function (n, c) { return n + ((c.materials || []).length); }, 0);
  $('subline').textContent = total
    ? total + ' material' + (total === 1 ? '' : 's') + ' across ' + manifest.classes.length +
      ' class' + (manifest.classes.length === 1 ? '' : 'es') + '.'
    : 'No materials listed yet.';
}

/* ============================================================ recents */

function recordRecent(m) {
  if (!window.StudyStore || !safePath(m.path)) return;
  StudyStore.get('recent').then(function (list) {
    list = Array.isArray(list) ? list : [];
    list = list.filter(function (r) { return r && r.path !== m.path; });
    list.unshift({ path: m.path, title: m.title || m.id, ts: Date.now() });
    StudyStore.set('recent', list.slice(0, 8));
  });
}

function renderRecents() {
  if (!window.StudyStore) return;
  StudyStore.get('recent').then(function (list) {
    if (!Array.isArray(list) || !list.length) return;
    var box = $('recent');
    box.innerHTML = '';
    list.forEach(function (r) {
      if (!r || !safePath(r.path)) return;
      var a = document.createElement('a');
      a.className = 'chip';
      a.href = r.path;
      a.textContent = r.title || r.path;
      box.appendChild(a);
    });
    $('recentwrap').hidden = !box.children.length;
  });
}

/* ============================================================ hash routing */

function handleHash() {
  var h = (location.hash || '').replace(/^#/, '');
  if (!h) return;

  if (h.indexOf('pair=') === 0) {
    var code = decodeURIComponent(h.slice(5));
    var panel = $('syncpanel');
    panel.open = true;
    $('paircode').value = code;
    panel.scrollIntoView({ block: 'start' });
    $('pairerr').hidden = true;
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

function paintStatus(st) {
  var dot = $('syncdot');
  var line = $('statusline');
  var sum = $('syncsum');
  dot.className = 'dot';

  if (!st.configured) {
    dot.classList.add('off');
    sum.textContent = 'local only';
    line.textContent = 'Sync is not configured yet. Everything still saves on this device, and the copy-and-paste backup below works with no server at all.';
  } else if (!st.paired) {
    dot.classList.add('off');
    sum.textContent = 'not paired';
    line.textContent = 'Saved on this device. Pair with a code to keep your other devices in step.';
  } else if (st.state === 'syncing') {
    dot.classList.add('busy');
    sum.textContent = 'syncing';
    line.textContent = 'Syncing…';
  } else if (st.state === 'offline') {
    dot.classList.add('off');
    sum.textContent = 'offline';
    line.textContent = 'Offline — changes are saved on this device and will sync when you are back online.';
  } else if (st.state === 'error') {
    dot.classList.add('bad');
    sum.textContent = 'retrying';
    line.textContent = st.message || 'Sync hit a problem. It will try again.';
  } else {
    dot.classList.add('ok');
    sum.textContent = 'synced';
    line.textContent = 'Synced ' + relTime(st.lastSyncedAt) + (st.dirty ? ' · changes pending' : '') + '.';
  }

  $('unpaired').hidden = st.paired;
  $('paired').hidden = !st.paired;
  if (st.paired && st.codeDisplay) {
    $('maskedcode').textContent = st.codeDisplay.slice(0, 4) + '-••••-••••';
    $('maskedcode').dataset.code = st.codeDisplay;
  }
  $('pairnote').textContent = st.configured
    ? 'One code links your devices. Keep it to yourself — it is the only thing guarding your progress.'
    : 'Add your Supabase URL and anon key at the top of assets/sync.js to switch this on.';
}

function doPair() {
  var val = $('paircode').value;
  var errEl = $('pairerr');
  errEl.hidden = true;
  try {
    StudyStore.pair(val).then(function (formatted) {
      $('paircode').value = '';
      errEl.hidden = true;
      window.alert('Paired. Your progress will merge with code ' + formatted + '.');
    });
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
  }
}

function initSyncPanel() {
  if (!window.StudyStore) {
    $('statusline').textContent = 'Sync module did not load, so this device is on its own. Materials still save locally.';
    $('syncsum').textContent = 'unavailable';
    ['makecode', 'dopair', 'doexport', 'doimport'].forEach(function (id) {
      var el = $(id); if (el) el.disabled = true;
    });
    return;
  }

  StudyStore.on('status', paintStatus);
  setInterval(function () { paintStatus(StudyStore.status()); }, 30000);

  $('makecode').addEventListener('click', function () {
    var code = StudyStore.createPairCode();
    $('bigcode').textContent = code;
    $('codeout').hidden = false;
    $('unpaired').hidden = true;
    var url = location.href.split('#')[0] + '#pair=' + encodeURIComponent(code);
    renderQR(url, $('qr'));
  });
  $('codedone').addEventListener('click', function () {
    $('codeout').hidden = true;
    paintStatus(StudyStore.status());
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
    var full = $('maskedcode').dataset.code || '';
    renderQR(location.href.split('#')[0] + '#pair=' + encodeURIComponent(full), $('pairedqr'));
    wrap.hidden = false;
    this.textContent = 'Hide square';
  });

  $('syncnow').addEventListener('click', function () { StudyStore.syncNow('manual'); });

  $('unpair').addEventListener('click', function () {
    if (!window.confirm('Unpair this device? Your progress stays here; it just stops syncing.')) return;
    StudyStore.unpair();
    $('pairedqrwrap').hidden = true;
    paintStatus(StudyStore.status());
  });

  /* -------- export / import -------- */

  $('doexport').addEventListener('click', function () {
    StudyStore.exportCode().then(function (code) {
      var box = $('iobox');
      box.value = code;
      box.hidden = false;
      box.readOnly = true;
      $('iorow').hidden = false;
      $('copyout').hidden = false;
      $('preview').hidden = true;
      $('importpreview').hidden = true;
      box.focus();
      box.select();
    });
  });

  $('copyout').addEventListener('click', function () {
    var box = $('iobox');
    var done = function () { $('copyout').textContent = 'Copied'; setTimeout(function () { $('copyout').textContent = 'Copy'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(done, function () { box.select(); document.execCommand('copy'); done(); });
    } else {
      box.select(); document.execCommand('copy'); done();
    }
  });

  $('doimport').addEventListener('click', function () {
    var box = $('iobox');
    box.value = '';
    box.hidden = false;
    box.readOnly = false;
    $('iorow').hidden = false;
    $('copyout').hidden = true;
    $('preview').hidden = false;
    $('importpreview').hidden = true;
    box.focus();
  });

  $('preview').addEventListener('click', function () {
    var out = $('importpreview');
    out.hidden = false;
    out.textContent = 'Reading…';
    StudyStore.previewImport($('iobox').value).then(function (p) {
      out.innerHTML = '';
      var h = document.createElement('h4');
      h.textContent = p.totalChanged ? 'This import would change:' : 'Nothing to change';
      out.appendChild(h);
      var ul = document.createElement('ul');
      p.summary.forEach(function (line) {
        var li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      out.appendChild(ul);

      if (p.totalChanged) {
        var row = document.createElement('div');
        row.className = 'row wrap';
        var apply = document.createElement('button');
        apply.className = 'btn';
        apply.type = 'button';
        apply.textContent = 'Apply';
        apply.addEventListener('click', function () {
          p.commit();
          out.innerHTML = '<h4>Imported</h4><p>Merged into this device. Reload a material to see it.</p>';
          renderRecents();
        });
        var cancel = document.createElement('button');
        cancel.className = 'btn ghost';
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', function () { p.discard(); out.hidden = true; });
        row.appendChild(apply);
        row.appendChild(cancel);
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

/* ============================================================ offline cache controls */

function initSWUpdateUI() {
  var note = $('swnote');
  var updateBtn = $('doupdate');

  $('clearcache').addEventListener('click', function () {
    var self = this;
    self.disabled = true;
    self.textContent = 'Clearing…';
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }).catch(function () {}).then(function () {
      return navigator.serviceWorker ? navigator.serviceWorker.getRegistration() : null;
    }).then(function (reg) {
      return reg ? reg.unregister() : null;
    }).catch(function () {}).then(function () {
      location.reload();
    });
  });

  if (!('serviceWorker' in navigator)) {
    note.textContent = 'This browser will not keep an offline copy.';
    return;
  }

  navigator.serviceWorker.getRegistration().then(function (reg) {
    swRegistration = reg;
    if (!reg) {
      note.textContent = 'No offline copy yet. Reload once while online to store one.';
      return;
    }
    note.textContent = 'The hub and the materials you have opened work offline.';

    var offerUpdate = function (worker) {
      if (!worker) return;
      note.textContent = 'A newer version is ready to install.';
      updateBtn.hidden = false;
      updateBtn.onclick = function () {
        updateBtn.disabled = true;
        updateBtn.textContent = 'Updating…';
        worker.postMessage({ type: 'SKIP_WAITING' });
      };
    };

    if (reg.waiting) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', function () {
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', function () {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw);
      });
    });

    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });

    reg.update().catch(function () {});
  }).catch(function () {
    note.textContent = 'Could not check the offline copy.';
  });
}

/* ============================================================ boot */

function boot() {
  if (window.StudyStore) {
    try { StudyStore.init({ namespace: 'hub' }); } catch (e) {}
  }

  initSyncPanel();
  initSWUpdateUI();
  renderRecents();

  loadManifest().then(function (data) {
    manifest = data;
    $('err').hidden = true;
    renderAll('');
    handleHash();
  }).catch(function (err) {
    showError(err);
    $('subline').textContent = 'The material list could not be read.';
  });

  var filter = $('filter');
  var t = null;
  filter.addEventListener('input', function () {
    clearTimeout(t);
    t = setTimeout(function () {
      if (manifest) renderAll(filter.value.trim().toLowerCase());
    }, 90);
  });

  window.addEventListener('hashchange', handleHash);
  window.addEventListener('pageshow', renderRecents);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* ============================================================================
 * Minimal QR encoder — byte mode, error correction level L, versions 1–10.
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
    p.textContent = 'Could not draw the square — use the code above instead.';
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

})();
