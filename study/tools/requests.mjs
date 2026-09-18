#!/usr/bin/env node
/* Study Hub request inbox.
 *
 *   node study/tools/requests.mjs            fetch new requests, save them, mark seen, purge
 *   node study/tools/requests.mjs --all      list every request, no downloading
 *   node study/tools/requests.mjs --keep     download but do not purge
 *
 * A request's attached files live only in Postgres until this tool pulls them down; see
 * study/supabase/migrations/0007_requests.sql for why. Saved requests land under
 * study/src/sources/requests/<date>-<ref>/, inside the study/src/ tree that is already
 * gitignored and lives only on this Mac.
 *
 * Your admin code is read from the STUDY_ADMIN_CODE environment variable and is never
 * written to disk or printed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const OUT = join(STUDY, 'src', 'sources', 'requests');

/* Overridable so the same tool can target a scratch project without editing this file. */
const SB = process.env.STUDY_SB_URL || 'https://gyfqhkhgosjpyvatffbi.supabase.co';
const ANON = process.env.STUDY_SB_KEY || 'sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb';

const die = m => { console.error('\n  ' + m + '\n'); process.exit(1); };

async function rpc(fn, body) {
  const res = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  /* PostgREST answers 404 both when a function does not exist (code PGRST202) and when one
     exists but a call inside it names a function that does not (42883). Only the first means
     the migration is missing; the second is a bug worth printing in full. */
  if (res.status === 404) {
    const body = await res.text();
    if (/PGRST202/.test(body)) {
      die('The inbox functions are not on the server yet. Run study/supabase/migrations/0007_requests.sql in the Supabase SQL editor.');
    }
    die(`${fn} failed on the server: ${body.slice(0, 300)}`);
  }
  if (!res.ok) die(`${fn} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/* Identical to StudyAuth.normalize in assets/auth.js and to publish.mjs's own copy. */
const normalizeCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function adminToken() {
  const code = process.env.STUDY_ADMIN_CODE;
  if (!code) die('Set STUDY_ADMIN_CODE first:\n    export STUDY_ADMIN_CODE=...');
  const r = await rpc('auth_login', { p_code: normalizeCode(code) });
  if (!r.ok) die('That admin code was rejected.');
  if (r.role !== 'admin') die(`That code is a ${r.role} code, not an admin code.`);
  /* Every sign in makes a session that lives 180 days, and one run of this script used to
     leave one behind each time: the owner panel's device count grew by one per run and could
     not be told apart from a real device. The session is closed once the run has finished. */
  if (!openSession) process.once('beforeExit', async () => {
    const t = openSession; openSession = null;
    if (t) { try { await rpc('auth_logout', { p_token: t }); } catch (e) {} }
  });
  openSession = r.token;
  return r.token;
}
let openSession = null;

const safeName = s => String(s || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

function requestMarkdown(req) {
  const lines = [];
  lines.push(`# Request ${req.id}`, '');
  lines.push(`Status: ${req.status}`);
  lines.push(`Created: ${req.created_at}`);
  lines.push(`Subject: ${req.subject || ''}`);
  lines.push(`Purpose: ${req.purpose || ''}`);
  lines.push(`Due: ${req.due || ''}`);
  lines.push(`Features: ${(req.features || []).join(', ')}`);
  lines.push(`Other: ${req.other || ''}`);
  lines.push(`From: ${req.from_name || ''}`, '');
  lines.push('Notes:');
  lines.push(req.notes || '(none)', '');
  lines.push('Files:');
  const files = req.files || [];
  if (files.length) {
    files.forEach(f => lines.push(`- ${f.name} (${f.size} bytes)${f.purged ? ' (already removed)' : ''}`));
  } else {
    lines.push('(none)');
  }
  return lines.join('\n') + '\n';
}

async function downloadFile(token, file, dir) {
  const CHUNK = 2 * 1024 * 1024;
  const parts = [];
  let offset = 0;
  let total = null;
  for (;;) {
    const r = await rpc('admin_request_file', { p_token: token, p_file: file.id, p_offset: offset, p_len: CHUNK });
    if (!r.ok) die(`downloading ${file.name} failed: ${r.error}`);
    total = r.total;
    const buf = Buffer.from(r.b64, 'base64');
    if (buf.length) parts.push(buf);
    offset += buf.length;
    if (buf.length === 0 || offset >= total) break;
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== total) die(`size mismatch downloading ${file.name}: got ${bytes.length}, expected ${total}`);
  writeFileSync(join(dir, safeName(file.name)), bytes);
  return bytes.length;
}

async function listAll(token) {
  const r = await rpc('admin_requests', { p_token: token, p_all: true });
  if (!r.ok) die(`Could not list requests: ${r.error}`);
  if (!r.requests.length) { console.log('No new requests.'); return; }
  r.requests.forEach(req => {
    const when = req.created_at || '';
    const n = (req.files || []).length;
    console.log(`  ${req.status.padEnd(9)} ${when}  ${req.subject || '(no subject)'}  (${n} file${n === 1 ? '' : 's'})`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const keep = args.includes('--keep');
  const token = await adminToken();

  if (all) { await listAll(token); return; }

  const r = await rpc('admin_requests', { p_token: token, p_all: false });
  if (!r.ok) die(`Could not list requests: ${r.error}`);
  if (!r.requests.length) { console.log('No new requests.'); return; }

  for (const req of r.requests) {
    const date = (req.created_at || '').slice(0, 10) || 'unknown-date';
    const ref = req.id.slice(0, 6);
    const dir = join(OUT, `${date}-${ref}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'request.md'), requestMarkdown(req));

    let savedFiles = 0;
    for (const f of (req.files || [])) {
      if (f.purged) continue;
      await downloadFile(token, f, dir);
      savedFiles++;
    }

    if (!keep) {
      await rpc('admin_request_mark', { p_token: token, p_id: req.id, p_status: 'seen' });
      await rpc('admin_request_purge', { p_token: token, p_id: req.id });
    }

    console.log(`  new: ${req.subject || '(no subject)'}, ${savedFiles} file${savedFiles === 1 ? '' : 's'}, saved to ${dir}`);
  }
}

await main();
