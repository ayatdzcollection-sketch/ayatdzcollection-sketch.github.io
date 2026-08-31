#!/usr/bin/env node
/* Study Hub publisher.
 *
 *   node study/tools/publish.mjs            encrypt every source and register it
 *   node study/tools/publish.mjs --pull     decrypt everything back into src/
 *   node study/tools/publish.mjs --bootstrap   set the two codes, first run only
 *
 * Plaintext materials live in study/src/m/ and are never committed. What ships to
 * GitHub Pages is study/m/<name>.enc — AES-256-GCM ciphertext. The key lives only in
 * Supabase and is handed out to a logged-in browser.
 *
 * Losing study/src/ is survivable: --pull rebuilds it from the published ciphertext
 * plus the keys, using your admin code.
 *
 * Your admin code is read from the STUDY_ADMIN_CODE environment variable and is never
 * written to disk or printed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const SRC = join(STUDY, 'src', 'm');
const OUT = join(STUDY, 'm');
const MANIFEST = join(STUDY, 'materials.json');

/* Overridable so the same tool can target a scratch project, or a local stand-in
   during testing, without editing this file. */
const SB = process.env.STUDY_SB_URL || 'https://gyfqhkhgosjpyvatffbi.supabase.co';
const ANON = process.env.STUDY_SB_KEY || 'sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb';
const MAGIC = Buffer.from('SHE1');

const die = m => { console.error('\n  ' + m + '\n'); process.exit(1); };

async function rpc(fn, body) {
  const res = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) die(`${fn} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/* ---------- crypto ---------- */

function encrypt(plaintext, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

function decrypt(buf, keyB64) {
  if (!buf.subarray(0, 4).equals(MAGIC)) die('not a Study Hub encrypted file');
  const key = Buffer.from(keyB64, 'base64');
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(buf.length - 16);
  const body = buf.subarray(16, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/* The viewer runs at /study/view.html, so a material's own "../../assets/..." would
   resolve a level too high. Rewritten here rather than in each material, so the source
   files stay openable on their own. */
const toViewerPaths = html => html.replace(/(["'(])\.\.\/\.\.\/assets\//g, '$1assets/');
const toSourcePaths = html => html.replace(/(["'(])assets\/(sync|hub)\.js/g, '$1../../assets/$2.js');

/* ---------- login ---------- */

async function adminToken() {
  const code = process.env.STUDY_ADMIN_CODE;
  if (!code) die('Set STUDY_ADMIN_CODE first:\n    export STUDY_ADMIN_CODE=...');
  const r = await rpc('auth_login', { p_code: code });
  if (!r.ok) die('That admin code was rejected.');
  if (r.role !== 'admin') die(`That code is a ${r.role} code, not an admin code.`);
  return r.token;
}

/* ---------- commands ---------- */

async function bootstrap() {
  const admin = process.env.STUDY_ADMIN_CODE;
  const viewer = process.env.STUDY_VIEWER_CODE;
  if (!admin || !viewer) die('Set both STUDY_ADMIN_CODE and STUDY_VIEWER_CODE.');
  const r = await rpc('auth_bootstrap', { p_admin_code: admin, p_viewer_code: viewer });
  if (!r.ok) die(`Bootstrap refused: ${r.error}`);
  console.log('  Codes set. They exist only as bcrypt hashes now — keep your copies safe.');
}

function walkSources() {
  const out = [];
  if (!existsSync(SRC)) return out;
  for (const cls of readdirSync(SRC)) {
    const dir = join(SRC, cls);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.html')) out.push({ cls, file: f, id: `${cls}/${f.replace(/\.html$/, '')}` });
    }
  }
  return out;
}

async function push() {
  const token = await adminToken();
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const byId = new Map();
  for (const c of manifest.classes || []) {
    for (const m of c.materials || []) {
      byId.set(m.id.includes('/') ? m.id : `${c.id}/${m.id}`, { klass: c, mat: m });
    }
  }

  const sources = walkSources();
  if (!sources.length) die(`No sources found in ${relative(process.cwd(), SRC)}`);

  for (const s of sources) {
    const entry = byId.get(s.id);
    if (!entry) {
      console.log(`  skip   ${s.id}  (not listed in materials.json)`);
      continue;
    }

    // Reuse the existing key so devices that already cached it keep working offline.
    let keyB64 = null;
    const got = await rpc('auth_material_key', { p_token: token, p_id: s.id });
    if (got.ok) keyB64 = got.key;
    if (!keyB64) keyB64 = randomBytes(32).toString('base64');

    const plain = readFileSync(join(SRC, s.cls, s.file), 'utf8');
    const enc = encrypt(toViewerPaths(plain), keyB64);
    const outDir = join(OUT, s.cls);
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, s.file.replace(/\.html$/, '.enc'));
    writeFileSync(outFile, enc);

    const { klass, mat } = entry;
    const up = await rpc('admin_upsert_item', {
      p_token: token,
      p_item: {
        id: s.id,
        kind: 'material',
        class_id: klass.id,
        class_name: klass.name,
        term: klass.term,
        title: mat.title,
        blurb: mat.blurb,
        path: `m/${s.cls}/${s.file.replace(/\.html$/, '.enc')}`,
        tags: mat.tags || [],
        added: mat.added || null,
        sort: mat.sort ?? 100,
        enc_key: keyB64
      }
    });
    if (!up.ok) die(`registering ${s.id} failed: ${up.error}`);
    console.log(`  ok     ${s.id}  ->  ${relative(STUDY, outFile)}  (${(enc.length / 1024).toFixed(0)} KB)`);
  }

  console.log('\n  Published. Commit the .enc files; never commit study/src/.');
}

async function pull() {
  const token = await adminToken();
  const cat = await rpc('auth_catalog', { p_token: token });
  if (!cat.ok) die('Could not read the catalog.');

  for (const item of cat.items) {
    if (item.kind !== 'material' || !item.path) continue;
    const encFile = join(STUDY, item.path);
    if (!existsSync(encFile)) { console.log(`  miss   ${item.id}  (${item.path} not on disk)`); continue; }
    const got = await rpc('auth_material_key', { p_token: token, p_id: item.id });
    if (!got.ok) { console.log(`  nokey  ${item.id}`); continue; }
    const html = toSourcePaths(decrypt(readFileSync(encFile), got.key));
    const [cls, name] = item.id.split('/');
    mkdirSync(join(SRC, cls), { recursive: true });
    writeFileSync(join(SRC, cls, `${name}.html`), html);
    console.log(`  ok     ${item.id}  ->  src/m/${cls}/${name}.html`);
  }
}

const arg = process.argv[2];
if (arg === '--bootstrap') await bootstrap();
else if (arg === '--pull') await pull();
else await push();
