// Downloads everything to ./out:
//   answers.csv   one row per student: details, times, every answer, Section A score
//   activity.csv  one row per student: counts of each logged behaviour (for spotting anomalies)
//   joins.csv     every join with IP and browser
//   events.jsonl  full decoded activity log, one event per line (t = ms since contest start)
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { db, config } from '../lib/server.js';
import { ANSWER_KEYS } from '../lib/paper.js';
import { MCQ_KEY, MCQ_POINTS } from '../lib/key.js';
import { toCSV } from './csv.js';

const sql = db();
const cfg = config();
mkdirSync('out', { recursive: true });
const iso = d => (d ? new Date(d).toISOString() : '');
const keys = [...ANSWER_KEYS];

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
console.log(`Exported ${answers.length} students, ${joins.length} joins, ${n} events to ./out (contest ${iso(cfg.start)} to ${iso(cfg.end)})`);
await sql.end();
