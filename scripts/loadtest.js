// Load test: simulates many students entering at once and saving, against your deployed site.
//
//   npm run loadtest -- --url https://your-site.vercel.app --students 1000 --minutes 3
//
// Options: --students N (default 300)  --minutes M of saving after entry (default 3)
//          --ramp S seconds over which everyone enters (default 15, like the real start)
//          --sync S seconds between saves per student (default 30; the real site uses SYNC_SECONDS)
//
// Needs CONTEST_MODE=practice on the site (so codes open immediately; students get the sample paper)
// and DATABASE_URL in .env (it creates temporary "LOADTEST" students and deletes them afterwards).
// Each simulated student makes 1 + minutes*60/sync requests, which count towards your Vercel usage.
import { db, genCode } from '../lib/server.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = String(arg('url', '')).replace(/\/+$/, '');
const N = Number(arg('students', 300)), MIN = Number(arg('minutes', 3)), RAMP = Number(arg('ramp', 15)), SYNC = Number(arg('sync', 30));
if (!BASE) { console.log('Give the site address: npm run loadtest -- --url https://your-site.vercel.app'); process.exit(1); }

const sql = db();
const stats = { join: [], sync: [] }, errors = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const note = (what, e) => { const k = `${what}: ${e}`; errors.set(k, (errors.get(k) || 0) + 1); };

async function call(kind, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    stats[kind].push(Date.now() - t0);
    if (!r.ok) note(kind, `HTTP ${r.status} ${j.error || ''}`.trim());
    return j;
  } catch (e) { stats[kind].push(Date.now() - t0); note(kind, e.cause?.code || e.message); return {}; }
}

const filler = n => Array.from({ length: n }, () => 'abcdefghij klmnop'[Math.floor(Math.random() * 17)]).join('');
async function student(code, i) {
  await sleep(Math.random() * RAMP * 1000);
  const j = await call('join', { code });
  if (j.status !== 'open') { if (j.status) note('join', `status ${j.status} (is CONTEST_MODE=practice?)`); return; }
  const keys = j.paper.sections.flatMap(s => s.problems.flatMap(p => p.type === 'written' ? p.parts.map(pt => p.id + pt.id) : [p.id]));
  const end = Date.now() + MIN * 60_000;
  let seq = 0;
  await sleep(Math.random() * SYNC * 1000);
  while (Date.now() < end) {
    const k = keys[Math.floor(Math.random() * keys.length)];
    const ev = Array.from({ length: 150 }, (_, n) => `${120 + (n % 7) * 30},k,${k},c,${n}`).join(';');
    await call('sync', { code, token: j.token, seq: seq++, ans: { [k]: filler(400 + Math.floor(Math.random() * 800)) }, ev, base: 60000 * seq, clientNow: Date.now(), snap: seq % 5 === 0 });
    await sleep(SYNC * 1000);
  }
}

console.log(`Creating ${N} temporary students…`);
const codes = [];
for (let i = 0; i < N; i += 500) {
  const batch = Array.from({ length: Math.min(500, N - i) }, (_, k) => ({ code: genCode(), name: `LOADTEST ${i + k + 1}`, school: 'LOADTEST' }));
  await sql`insert into students ${sql(batch, 'code', 'name', 'school')}`;
  codes.push(...batch.map(b => b.code));
}
console.log(`${N} students enter over ${RAMP} s, then save every ${SYNC} s for ${MIN} min against ${BASE}`);
const t0 = Date.now();
const tick = setInterval(() => process.stdout.write(`\r  ${Math.round((Date.now() - t0) / 1000)} s · ${stats.join.length} entries · ${stats.sync.length} saves · ${[...errors.values()].reduce((a, b) => a + b, 0)} errors   `), 2000);
await Promise.all(codes.map((c, i) => student(c, i)));
clearInterval(tick);

console.log('\n\nResults (milliseconds)');
for (const k of ['join', 'sync']) {
  const a = stats[k];
  console.log(`  ${k === 'join' ? 'Enter ' : 'Save  '} ${String(a.length).padStart(6)} requests · median ${pct(a, 50)} · 95% under ${pct(a, 95)} · 99% under ${pct(a, 99)} · slowest ${pct(a, 100)}`);
}
if (errors.size) { console.log('Errors:'); for (const [k, n] of errors) console.log(`  ${n} × ${k}`); } else console.log('No errors.');
const slow = pct(stats.join, 95) > 5000 || pct(stats.sync, 95) > 5000;
console.log(errors.size || slow
  ? 'Verdict: NOT comfortable. Look at the errors above; consider Vercel Pro, a larger Neon compute size, or a longer SYNC_SECONDS.'
  : 'Verdict: handled this load comfortably.');

console.log('Removing the temporary students and their data…');
await sql`delete from logs where code in (select code from students where school = 'LOADTEST')`;
await sql`delete from joins where code in (select code from students where school = 'LOADTEST')`;
await sql`delete from marks where code in (select code from students where school = 'LOADTEST')`;
await sql`delete from sessions where code in (select code from students where school = 'LOADTEST')`;
await sql`delete from students where school = 'LOADTEST'`;
console.log('Done.');
await sql.end();
