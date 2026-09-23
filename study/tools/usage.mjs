#!/usr/bin/env node
/* Study Hub usage report: who studies, how, where they stop, what breaks.
 *
 *   node study/tools/usage.mjs            the summary
 *   node study/tools/usage.mjs --devices  plus one line per device
 *   node study/tools/usage.mjs --json F   also write the raw answer to file F
 *
 * Reads three owner only functions: telemetry_stats (totals), admin_telemetry_devices (one
 * line per device, no install id; migrations 0043 to 0047) and admin_telemetry_timing (answer
 * times by material and step; 0048, 0049). Nothing here writes to the server except the sign in
 * and the sign out.
 *
 * Devices are split three ways. The owner's: the device said it holds the owner's session
 * (from 2026-09-22 on). Tests: the page came from a local test server. Everyone else. Older
 * devices sent no description, so they cannot say which they are; those are counted as
 * everyone else and marked "no description".
 *
 * Your admin code is read from STUDY_ADMIN_CODE and never written or printed.
 */
import { writeFileSync } from 'node:fs';

const SB = process.env.STUDY_SB_URL || 'https://gyfqhkhgosjpyvatffbi.supabase.co';
const ANON = process.env.STUDY_SB_KEY || 'sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb';
const args = process.argv.slice(2);
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

const code = String(process.env.STUDY_ADMIN_CODE || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (!code) die('Set STUDY_ADMIN_CODE first (command in PLAYBOOK section 10).');
const login = await rpc('auth_login', { p_code: code });
if (!login.ok) die('That admin code was rejected.');
if (login.role !== 'admin') die(`That code is a ${login.role} code, not an admin code.`);
const token = login.token;

try {
  const [stats, dev, timing] = await Promise.all([
    rpc('telemetry_stats', {}),
    rpc('admin_telemetry_devices', { p_token: token }),
    rpc('admin_telemetry_timing', { p_token: token })
  ]);
  if (!dev.ok) die('admin_telemetry_devices: ' + JSON.stringify(dev));
  const jsonAt = args.indexOf('--json');
  if (jsonAt !== -1 && args[jsonAt + 1]) writeFileSync(args[jsonAt + 1], JSON.stringify({ stats, dev, timing }, null, 1));

  const list = dev.list || [];
  const who = x => x.owner ? 'owner' : x.local ? 'test' : 'others';
  const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const groups = { owner: [], test: [], others: [] };
  list.forEach(x => groups[who(x)].push(x));

  const line = (...a) => console.log(...a);
  line(`\nReviews ${stats.reviews} from ${stats.devices} devices, ${String(stats.first).slice(0, 10)} to ${String(stats.last).slice(0, 10)}`);
  if (stats.recalled_when_forecast_90) {
    const c = stats.recalled_when_forecast_90;
    line(`Calibration: forecast about 90%, recalled ${Math.round(c.recalled * 1000) / 10}% over ${c.n}`);
  }
  line('');
  for (const [k, xs] of Object.entries(groups)) {
    if (!xs.length) continue;
    const kinds = {};
    xs.forEach(x => kinds[x.kind] = (kinds[x.kind] || 0) + 1);
    const noDesc = xs.filter(x => !x.profile).length;
    line(`${k.padEnd(7)} ${String(xs.length).padStart(3)} devices ${String(sum(xs, x => x.reviews)).padStart(6)} reviews  ` +
      Object.entries(kinds).map(([a, b]) => `${b} ${a}`).join(', ') + (noDesc ? `  (${noDesc} no description)` : ''));
  }

  const others = groups.others;
  const repeats = sum(others, x => x.repeats), orev = sum(others, x => x.reviews);
  if (orev) line(`\nOthers came back to a card on a later day ${repeats} times in ${orev} reviews (${Math.round(repeats / orev * 1000) / 10}%)`);

  // Browsers, from devices that described themselves.
  const desc = list.filter(x => x.profile && !x.local);
  if (desc.length) {
    const tally = f => { const t = {}; desc.forEach(x => { const k = f(x.profile); if (k) t[k] = (t[k] || 0) + 1; }); return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', '); };
    line('\nBrowsers: ' + tally(p => [p.os, p.br + (p.brv ? ' ' + p.brv : '')].join(' ')));
    const apps = tally(p => p.app);
    if (apps) line('Opened inside an app: ' + apps);
    line('Home Screen: ' + desc.filter(x => x.profile.standalone).length + ' of ' + desc.length);
    const wiped = desc.filter(x => x.profile.id === 'new' && (x.profile.prior || []).length);
    const recovered = desc.filter(x => x.profile.id === 'cookie' || x.profile.id === 'idb');
    line(`Ids: ${recovered.length} recovered after localStorage was cleared, ${wiped.length} new but in a browser that had been here before`);
    const same = {}; desc.forEach(x => { if (x.same_as) (same[x.same_as] = same[x.same_as] || []).push(x.device); });
    const sg = Object.entries(same);
    if (sg.length) line('Probably one browser, wiped: ' + sg.map(([g, ds]) => `${g} ${ds.join('+')}`).join('; '));
    const pg = {}; list.forEach(x => { if (x.person) (pg[x.person] = pg[x.person] || []).push(x.device); });
    if (Object.keys(pg).length) line('Paired devices of one person: ' + Object.entries(pg).map(([g, ds]) => `${g} ${ds.join('+')}`).join('; '));
  }

  // Visits: how pages end.
  const withVisits = others.filter(x => x.visits);
  if (withVisits.length) {
    const pages = sum(withVisits, x => x.visits.pages), none = sum(withVisits, x => x.visits.no_answer);
    line(`\nVisits (others): ${pages} pages, ${none} ended with no answer, ${Math.round(sum(withVisits, x => x.visits.active_min))} minutes in front of a student`);
    const ended = {};
    withVisits.forEach(x => Object.entries(x.visits.ended_on || {}).forEach(([s, n]) => ended[s] = (ended[s] || 0) + n));
    line('Last screen before leaving: ' + Object.entries(ended).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', '));
    const from = {};
    withVisits.forEach(x => Object.entries(x.visits.came_from || {}).forEach(([s, n]) => from[s] = (from[s] || 0) + n));
    line('Came from: ' + Object.entries(from).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', '));
  }

  const nudges = list.flatMap(x => (x.nudges || []).map(n => ({ ...n, device: x.device })));
  if (nudges.length) {
    const picks = {}; nudges.forEach(n => picks[n.pick] = (picks[n.pick] || 0) + 1);
    line(`\nRough start suggestions: ${nudges.length} shown; ` + Object.entries(picks).map(([a, b]) => `${a} ${b}`).join(', '));
  }
  const checkins = list.filter(x => !x.local).flatMap(x => (x.checkins || []).map(c => ({ ...c, device: x.device, owner: x.owner })));
  if (checkins.length) {
    line('\nQuiz check ins:');
    checkins.forEach(c => line(`  ${c.device}${c.owner ? ' (owner)' : ''} ${c.material} quiz ${c.qd}: ${c.r}${c.score ? ' ' + c.score : ''} after ${c.n} answers`));
  }
  if ((dev.errors || []).length) {
    line('\nErrors:');
    dev.errors.slice(0, 15).forEach(e => line(`  ${String(e.count).padStart(3)}x on ${e.devices} device(s) ${JSON.stringify(e.materials)} ${e.file || ''}:${e.line ?? ''} ${e.msg}`));
  }

  if (timing && timing.ok) {
    const untimed = timing.rows.filter(r => r.n >= 5 && r.timed / r.n < 0.5);
    const fast = timing.rows.filter(r => r.timed >= 5 && r.under_half_s / r.timed > 0.3);
    if (untimed.length) line('\nSteps mostly without a time: ' + untimed.map(r => `${r.material} ${r.step} (${r.timed}/${r.n})`).join(', '));
    if (fast.length) line('Steps with many answers under half a second: ' + fast.map(r => `${r.material} ${r.step} (${r.under_half_s}/${r.timed})`).join(', '));
  }

  if (args.includes('--devices')) {
    line('');
    for (const x of list) {
      const p = x.profile || {};
      const b = x.profile ? [p.os, p.osv, p.br, p.brv, p.app ? 'in ' + p.app : '', p.standalone ? 'home screen' : '', p.id && p.id !== 'ls' ? 'id:' + p.id : ''].filter(Boolean).join(' ') : 'no description';
      line(`${who(x).padEnd(6)} ${x.device.padEnd(4)} ${x.kind.padEnd(9)} ${String(x.reviews).padStart(4)} rev ${String(x.days).padStart(2)} days right ${x.right ?? '-'} med ${x.median_s ?? '-'}s rep ${x.repeats ?? 0}  ${b}  ${JSON.stringify(x.by_material || {})}`);
    }
  }
  line('');
} finally {
  try { await rpc('auth_logout', { p_token: token }); } catch (e) {}
}
