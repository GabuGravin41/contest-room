// Ranks students for cheating review. Run after (or during) the contest:  npm run flags
//
// Writes to ./out:
//   flags.csv        every student who has at least one signal, highest score first, with plain reasons
//   flag-pairs.csv   pairs of students whose answers match in ways that are unlikely by chance
//
// A flag is a reason to look closer, never proof. Typical use: review High first, then Medium, and
// for doubtful high scorers ask them to explain one of their answers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { db, config, prettyCode } from '../lib/server.js';
import { activePaper } from '../lib/store.js';
import { permFor, shuffleOn } from '../lib/shuffle.js';
import { toCSV } from './csv.js';

const sql = db();
const cfg = config();
mkdirSync('out', { recursive: true });

const AP = await activePaper(sql);
const PAPER = AP.paper, MCQ_KEY = AP.key || {};
const problems = PAPER.sections.flatMap(s => s.problems);
const MCQS = problems.filter(p => p.type === 'mcq');
const TEXT_KEYS = problems.flatMap(p => p.type === 'written' ? p.parts.map(pt => p.id + pt.id) : p.type === 'algo' ? [p.id] : []);
const ALGO = new Set(problems.filter(p => p.type === 'algo').map(p => p.id));
const problemOf = k => k.replace(/[a-z]+$/, '');
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };

// ---------- load students, answers, joins ----------
const studs = await sql`select s.code, s.name, s.school, s.county, x.answers, x.first_join_at, x.join_count
  from students s join sessions x using (code) order by s.code`;
const idx = new Map(studs.map((s, i) => [s.code, i]));
const S = studs.map(s => ({ ...s, answers: s.answers || {}, score: 0, reasons: [], ips: new Set(), uas: new Set(), switches: 0 }));
const flag = (i, pts, why) => { S[i].score += pts; S[i].reasons.push(why); };

const joins = await sql`select code, kind, ip, ua from joins`;
const ipCodes = new Map();
for (const j of joins) {
  const i = idx.get(j.code); if (i == null) continue;
  S[i].ips.add(j.ip); S[i].uas.add(j.ua);
  if (j.kind === 'device_switch') S[i].switches++;
  if (!ipCodes.has(j.ip)) ipCodes.set(j.ip, new Set());
  ipCodes.get(j.ip).add(i);
}
const sharesIP = (a, b) => [...S[a].ips].some(ip => S[b].ips.has(ip));

// ---------- stream the activity log, one student at a time ----------
const DEVTOOLS = new Set(['F12', 'ctrl+shift+i', 'ctrl+shift+j', 'ctrl+shift+c', 'meta+alt+i', 'meta+alt+j', 'meta+alt+c']);
let cur = null;
function finish(st) {
  if (!st) return;
  const i = idx.get(st.code); if (i == null) return;
  const a = S[i].answers;
  if (st.pendingReturn) closeReturn(st, Infinity);

  // 1. text that was not typed
  for (const k of TEXT_KEYS) {
    const len = (a[k] || '').length;
    if (len < 150) continue;
    const accounted = (st.typed[k] || 0) + (st.pasted[k] || 0);
    if (accounted < 0.5 * len) flag(i, 30, `Problem ${k}: ${len} characters in the answer but only ${st.typed[k] || 0} typed (and ${st.pasted[k] || 0} moved from own answers)`);
    // 2. typed straight through with almost no corrections (weak on its own)
    const typed = st.typed[k] || 0, back = st.back[k] || 0;
    if (len >= 400 && typed >= 0.8 * len && back < 0.01 * typed) flag(i, 8, `Problem ${k}: ${len} characters typed with ${back} corrections (looks copied out, not composed)`);
  }
  for (const [k, n] of Object.entries(st.inserts)) if (n >= 50) flag(i, 20, `Problem ${k}: ${n} characters appeared at once without typing or pasting (autofill, dictation or injected text)`);

  // 3. speed: a long algorithm answer written within 3 minutes of first opening the problem
  for (const [k, t] of Object.entries(st.reached300)) {
    const opened = st.firstOpen[problemOf(k)];
    // 300 characters in 90 s means typing 3+ characters a second from the moment the problem appeared, with no reading time
    if (ALGO.has(k) && opened != null && t - opened < 90_000) flag(i, 15, `Problem ${k}: 300+ characters written ${mmss(t - opened)} after first opening it`);
  }
  // Section A all correct, very fast
  const allRight = MCQS.every(p => a[p.id] === MCQ_KEY[p.id]);
  if (allRight && st.lastMc != null && st.lastMc < 6 * 60_000) flag(i, 10, `All of Section A correct, finished ${mmss(st.lastMc)} after the start`);

  // 4. leaving the page
  if (st.bursts.length) flag(i, Math.min(36, 12 * st.bursts.length), `Left the page and wrote a lot right after returning, ${st.bursts.length}×: ${st.bursts.slice(0, 3).join('; ')}`);
  if (st.away > 10 * 60_000) flag(i, 10, `Away from the page ${mmss(st.away)} in total (${st.awayCount} times over 30 s)`);
  else if (st.awayCount >= 10) flag(i, 5, `Left the page ${st.awayCount} times for over 30 s`);

  // 5. behaviour
  if (st.pb >= 3) flag(i, 8, `${st.pb} blocked pastes from outside the contest`);
  if (st.cpq >= 2) flag(i, 8, `${st.cpq} attempts to copy question text`);
  if (st.dev) flag(i, 10, `Opened developer tools ${st.dev}×`);
  if (st.print) flag(i, 5, `Tried to print ${st.print}×`);
  if (st.fsx >= 5) flag(i, 3, `Left full screen ${st.fsx}×`);
  if (st.exp) flag(i, 0, `Saved an emergency copy of answers ${st.exp}× (server unreachable; not suspicious on its own)`);
  if (st.stale) flag(i, 15, `Two devices were writing at the same time (${st.stale} saves from a replaced device)`);
}
function closeReturn(st, t) {
  const r = st.pendingReturn;
  if (t - r.t > 120_000 || t === Infinity) {
    if (r.chars >= 150 || r.mc >= 2) st.bursts.push(`away ${mmss(r.dur)} then ${r.chars ? r.chars + ' characters' : r.mc + ' MCQ answers'} in 2 min (${[...r.keys].join(', ')})`);
    st.pendingReturn = null;
  }
}
function fresh(code) {
  return { code, typed: {}, back: {}, pasted: {}, inserts: {}, firstOpen: {}, reached300: {}, lastMc: null,
    awayStart: null, away: 0, awayCount: 0, pendingReturn: null, bursts: [], pb: 0, cpq: 0, dev: 0, print: 0, fsx: 0, exp: 0, stale: 0 };
}
await sql`select code, stale, base, events from logs order by code, received_at`.cursor(500, rows => {
  for (const l of rows) {
    if (!cur || cur.code !== l.code) { finish(cur); cur = fresh(l.code); }
    if (l.stale) cur.stale++;
    let t = Number(l.base) || 0;
    for (const e of (l.events || '').split(';')) {
      if (!e) continue;
      const [dt, type, q, x, y] = e.split(',');
      t += Number(dt) || 0;
      if (cur.pendingReturn) closeReturn(cur, t);
      switch (type) {
        case 'k':
          if (x === 'c' || x === 'e') {
            cur.typed[q] = (cur.typed[q] || 0) + 1;
            if (cur.pendingReturn) { cur.pendingReturn.chars++; cur.pendingReturn.keys.add(q); }
            if (Number(y) + 1 >= 300 && cur.reached300[q] == null) cur.reached300[q] = t;
          } else if (x === 'b' || x === 'd') cur.back[q] = (cur.back[q] || 0) + 1;
          break;
        case 'p': cur.pasted[q] = (cur.pasted[q] || 0) + (Number(x) || 0); break;
        case 'in': cur.inserts[q] = (cur.inserts[q] || 0) + (Number(x) || 0); break;
        case 'pb': cur.pb++; break;
        case 'cp': if (String(y).endsWith('-q')) cur.cpq++; break;
        case 'kb': if (DEVTOOLS.has(x)) cur.dev++; else if (x === 'print' || x === 'ctrl+p' || x === 'meta+p') cur.print++; break;
        case 'fsx': cur.fsx++; break;
        case 'exp': cur.exp++; break;
        case 'go': if (cur.firstOpen[q] == null) cur.firstOpen[q] = t; break;
        case 'mc':
          cur.lastMc = t;
          if (cur.pendingReturn) { cur.pendingReturn.mc++; cur.pendingReturn.keys.add(q); }
          break;
        case 'hid': case 'bl': if (cur.awayStart == null) cur.awayStart = t; break;
        case 'vis': case 'fo':
          if (cur.awayStart != null) {
            const dur = t - cur.awayStart; cur.away += dur; if (dur > 30_000) cur.awayCount++;
            if (dur >= 60_000) cur.pendingReturn = { t, dur, chars: 0, mc: 0, keys: new Set() };
            cur.awayStart = null;
          }
          break;
      }
    }
  }
});
finish(cur);

// ---------- devices ----------
S.forEach((s, i) => {
  if (s.uas.size >= 2 && s.switches) flag(i, 10, `Code used on ${s.uas.size} different browsers/devices (${s.switches} switch${s.switches > 1 ? 'es' : ''})`);
  if (s.ips.size >= 3) flag(i, 5, `Code used from ${s.ips.size} different IP addresses`);
});

// ---------- pairs: multiple choice ----------
const pairs = [];
const N = S.length;
const nq = MCQS.length;
const canon = new Uint8Array(N * nq).fill(255), shown = new Uint8Array(N * nq).fill(255);
MCQS.forEach((p, q) => {
  S.forEach((s, i) => {
    const L = s.answers[p.id]; const o = 'ABCDE'.indexOf(L || '?');
    if (o < 0) return;
    canon[i * nq + q] = o;
    shown[i * nq + q] = shuffleOn() ? permFor(s.code, p.id, p.options.length).indexOf(o) : o;
  });
});
// how common each wrong answer is
const rarity = MCQS.map((p, q) => {
  const counts = new Array(5).fill(0); let n = 0;
  for (let i = 0; i < N; i++) { const o = canon[i * nq + q]; if (o !== 255) { counts[o]++; n++; } }
  return counts.map(c => (n && c ? -Math.log(c / n) : 0));
});
const keyIdx = MCQS.map(p => 'ABCDE'.indexOf(MCQ_KEY[p.id] || '?'));
// With only a handful of multiple-choice problems, matching patterns between strangers happen by chance
// among thousands of students. So: anywhere in the country, require almost all wrong answers identical;
// for students at the same school or on the same IP address, a slightly lower bar.
const near = (a, b) => (S[a].school && S[a].school === S[b].school) || sharesIP(a, b);
const answered = i => { let n = 0; for (let q = 0; q < nq; q++) if (canon[i * nq + q] !== 255) n++; return n; };
for (let a = 0; a < N; a++) {
  for (let b = a + 1; b < N; b++) {
    let sameWrong = 0, rare = 0, letters = 0; const qs = [], lq = [];
    for (let q = 0; q < nq; q++) {
      const ca = canon[a * nq + q], cb = canon[b * nq + q];
      if (ca === 255 || cb === 255) continue;
      if (ca === cb && ca !== keyIdx[q]) { sameWrong++; rare += rarity[q][ca]; qs.push(MCQS[q].id); }
      if (shuffleOn() && ca !== cb && shown[a * nq + q] === shown[b * nq + q]) { letters++; lq.push(MCQS[q].id); }
    }
    const close = near(a, b);
    const needWrong = Math.max(4, Math.ceil(nq * (close ? 0.65 : 0.85)));
    if (sameWrong >= needWrong && rare >= 2 * sameWrong) pairs.push({ kind: 'same wrong MCQ answers', a, b, pts: 20, detail: `${sameWrong} identical wrong answers (problems ${qs.join(', ')})` });
    if (shuffleOn() && letters >= 3) {
      // same on-screen letter on (nearly) every problem both answered, while the underlying options differ
      let sameShown = 0, both = 0;
      for (let q = 0; q < nq; q++) { const x = shown[a * nq + q], y = shown[b * nq + q]; if (x !== 255 && y !== 255) { both++; if (x === y) sameShown++; } }
      if (both >= Math.min(6, nq) && sameShown >= both - (close ? 1 : 0)) pairs.push({ kind: 'same on-screen letters', a, b, pts: 30, detail: `picked the same on-screen letter on ${sameShown} of ${both} problems although their options were shown in different orders (${letters} of them are different actual answers): typical of sharing "the answer to 3 is B"` });
    }
  }
}

// ---------- pairs: written and algorithm answers ----------
const shingles = txt => {
  const w = String(txt || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 5 <= w.length; i++) set.add(w.slice(i, i + 5).join(' '));
  return set;
};
for (const k of TEXT_KEYS) {
  const sets = S.map(s => ((s.answers[k] || '').length >= 150 ? shingles(s.answers[k]) : null));
  const inv = new Map();
  sets.forEach((set, i) => { if (set) for (const sh of set) { if (!inv.has(sh)) inv.set(sh, []); inv.get(sh).push(i); } });
  const cap = Math.max(10, Math.ceil(0.02 * N)); // phrases many students share (e.g. restating the problem) are ignored
  const shared = new Map();
  for (const list of inv.values()) {
    if (list.length < 2 || list.length > cap) continue;
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const key = list[x] * 65536 + list[y]; shared.set(key, (shared.get(key) || 0) + 1);
    }
  }
  for (const [key, n] of shared) {
    const a = Math.floor(key / 65536), b = key % 65536;
    const jac = n / (sets[a].size + sets[b].size - n);
    if (n >= 15 && jac >= 0.5) pairs.push({ kind: 'matching written answer', a, b, pts: 40, detail: `Problem ${k}: ${Math.round(jac * 100)}% of 5-word phrases identical` });
  }
}

for (const p of pairs) {
  const ip = sharesIP(p.a, p.b), sch = S[p.a].school && S[p.a].school === S[p.b].school;
  const extra = [ip && 'same IP address', sch && 'same school'].filter(Boolean).join(', ');
  flag(p.a, p.pts, `${p.kind} with ${prettyCode(S[p.b].code)} ${S[p.b].name || ''}: ${p.detail}${extra ? ` (${extra})` : ''}`);
  flag(p.b, p.pts, `${p.kind} with ${prettyCode(S[p.a].code)} ${S[p.a].name || ''}: ${p.detail}${extra ? ` (${extra})` : ''}`);
  p.ip = ip; p.sch = sch;
}

// ---------- write ----------
const level = s => (s >= 40 ? 'High' : s >= 20 ? 'Medium' : s >= 5 ? 'Low' : 'Note');
const flagged = S.filter(s => s.reasons.length).sort((x, y) => y.score - x.score);
const secA = s => MCQS.reduce((t, p) => t + (s.answers[p.id] === MCQ_KEY[p.id] ? p.marks : 0), 0);
writeFileSync('out/flags.csv', toCSV(['level', 'score', 'code', 'name', 'school', 'county', 'section_a_score', 'reasons'],
  flagged.map(s => ({ level: level(s.score), score: s.score, code: prettyCode(s.code), name: s.name, school: s.school, county: s.county, section_a_score: secA(s), reasons: s.reasons.join(' | ') }))));
writeFileSync('out/flag-pairs.csv', toCSV(['kind', 'code_a', 'name_a', 'school_a', 'code_b', 'name_b', 'school_b', 'same_ip', 'same_school', 'detail'],
  pairs.map(p => ({ kind: p.kind, code_a: prettyCode(S[p.a].code), name_a: S[p.a].name, school_a: S[p.a].school, code_b: prettyCode(S[p.b].code), name_b: S[p.b].name, school_b: S[p.b].school, same_ip: p.ip ? 'yes' : '', same_school: p.sch ? 'yes' : '', detail: p.detail }))));

const by = l => flagged.filter(s => level(s.score) === l).length;
console.log(`Checked ${N} students who joined. High: ${by('High')} · Medium: ${by('Medium')} · Low: ${by('Low')} · matching pairs: ${pairs.length}`);
console.log('Wrote out/flags.csv and out/flag-pairs.csv. A flag is a reason to look closer, not proof.');
await sql.end();
