// Downloads everything to ./out:
//   results.csv   one row per student: Section A score, marks per written problem, total and rank
//   answers.csv   one row per student: details, times, every answer, Section A score
//   activity.csv  one row per student: counts of each logged behaviour (for spotting anomalies)
//   joins.csv     every join with IP and browser
//   events.jsonl  full decoded activity log, one event per line (t = ms since contest start)
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { db, config } from '../lib/server.js';
import { servedPaper, ensureTables } from '../lib/store.js';
import { toCSV } from './csv.js';

const sql = db();
const cfg = config();
mkdirSync('out', { recursive: true });
const iso = d => (d ? new Date(d).toISOString() : '');
await ensureTables(sql);
const AP = await servedPaper(sql, cfg);
const MCQ_KEY = AP.key || {}, MCQ_POINTS = AP.points || {};
const keys = [...AP.answerKeys];

const rows = await sql`select s.*, x.first_join_at, x.last_sync_at, x.submitted_at, x.join_count, x.sync_count, x.late_syncs, x.answers
  from students s left join sessions x using (code) order by s.school, s.name`;
const answers = rows.map(r => {
  const a = r.answers || {};
  const score = Object.entries(MCQ_KEY).reduce((t, [q, k]) => t + (a[q] === k ? (MCQ_POINTS[q] ?? 2) : 0), 0);
  return { code: r.code, name: r.name, school: r.school, county: r.county, candidate_no: r.candidate_no,
    first_join: iso(r.first_join_at), last_sync: iso(r.last_sync_at), submitted: iso(r.submitted_at),
    joins: r.join_count ?? 0, section_a_score: r.first_join_at ? score : '', ...Object.fromEntries(keys.map(k => [k, a[k] ?? ''])) };
});
writeFileSync('out/answers.csv', toCSV(['code', 'name', 'school', 'county', 'candidate_no', 'first_join', 'last_sync', 'submitted', 'joins', 'section_a_score', ...keys], answers));

// Results: Section A (automatic) + marks entered on the marking page
const markable = AP.paper.sections.flatMap(x => x.problems).filter(p => p.type !== 'mcq').map(p => p.id);
const marks = await sql`select code, problem, score from marks where score is not null`;
const byCode = new Map();
for (const m of marks) { if (!byCode.has(m.code)) byCode.set(m.code, {}); byCode.get(m.code)[m.problem] = Number(m.score); }
const results = answers.filter(a => a.first_join).map(a => {
  const m = byCode.get(a.code) || {};
  const written = markable.reduce((t, p) => t + (m[p] ?? 0), 0);
  return { code: a.code, name: a.name, school: a.school, county: a.county, candidate_no: a.candidate_no, section_a: a.section_a_score,
    ...Object.fromEntries(markable.map(p => ['p' + p, m[p] ?? ''])), problems_marked: Object.keys(m).length, total: Number(a.section_a_score || 0) + written };
}).sort((x, y) => y.total - x.total);
results.forEach((r, i) => { r.rank = i && results[i - 1].total === r.total ? results[i - 1].rank : i + 1; });
writeFileSync('out/results.csv', toCSV(['rank', 'total', 'code', 'name', 'school', 'county', 'candidate_no', 'section_a', ...markable.map(p => 'p' + p), 'problems_marked'], results));

const joins = await sql`select code, at, kind, ip, ua from joins order by code, at`;
writeFileSync('out/joins.csv', toCSV(['code', 'at', 'kind', 'ip', 'ua'], joins.map(j => ({ ...j, at: iso(j.at) }))));

// Stream logs and decode.
const TYPES = ['k', 'in', 'p', 'pb', 'cp', 'bl', 'fo', 'hid', 'vis', 'fsx', 'fse', 'go', 'mc', 'fl', 'ctx', 'kb', 'rz', 'off', 'on', 'ld', 'sub'];
const act = new Map();
const ev = createWriteStream('out/events.jsonl');
let n = 0;
await sql`select code, seq, received_at, base, stale, late, final, answers, events from logs order by code, received_at`
  .cursor(500, async batch => {
    for (const l of batch) {
      const a = act.get(l.code) || { code: l.code, batches: 0, stale_batches: 0, away_ms: 0, _hidAt: null, max_gap_ms: 0, _last: null };
      a.batches++; if (l.stale) a.stale_batches++;
      if (l.answers) ev.write(JSON.stringify({ code: l.code, t: Number(l.base), type: 'snapshot', answers: l.answers }) + '\n');
      let t = Number(l.base) || 0;
      for (const e of (l.events || '').split(';')) {
        if (!e) continue;
        const [dt, type, q, x, y] = e.split(',');
        t += Number(dt) || 0;
        a[type] = (a[type] || 0) + 1;
        if (type === 'hid' || type === 'bl') a._hidAt ??= t;
        if ((type === 'vis' || type === 'fo') && a._hidAt != null) { a.away_ms += t - a._hidAt; a._hidAt = null; }
        if (a._last != null) a.max_gap_ms = Math.max(a.max_gap_ms, t - a._last);
        a._last = t;
        ev.write(JSON.stringify({ code: l.code, seq: l.seq, t, type, q: q || undefined, a: x || undefined, b: y || undefined, stale: l.stale || undefined }) + '\n');
        n++;
      }
      act.set(l.code, a);
    }
  });
ev.end();
writeFileSync('out/activity.csv', toCSV(['code', 'batches', 'stale_batches', 'away_ms', 'max_gap_ms', ...TYPES], [...act.values()]));
console.log(`Exported ${answers.length} students (${results.length} took part, results.csv ranked), ${joins.length} joins, ${n} events to ./out (contest ${iso(cfg.start)} to ${iso(cfg.end)})`);
await sql.end();
