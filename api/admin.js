// GET /api/admin?action=stats | student&code=... | devices    (header: x-admin-key)
// Read-only monitor. Bulk exports are done with `npm run export` (too large for a serverless response).
import { config, db, send, normCode, readBody, genCode, prettyCode } from '../lib/server.js';
import { PAPER } from '../lib/paper.js';

export default async function handler(req, res) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
  try {
    const sql = db();
    const cfg = config();
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || 'stats';

    if (action === 'stats') {
      const [r] = await sql`
        select
          (select count(*) from students)::int as students,
          (select count(*) from sessions)::int as joined,
          (select count(*) from sessions where last_sync_at > now() - interval '3 minutes')::int as active,
          (select count(*) from sessions where submitted_at is not null)::int as submitted,
          (select count(*) from sessions where join_count > 1 and exists
             (select 1 from joins j where j.code = sessions.code and j.kind = 'device_switch'))::int as device_switches,
          (select count(*) from logs)::int as log_batches,
          (select pg_size_pretty(pg_database_size(current_database()))) as db_size`;
      return send(res, 200, { ...r, serverNow: Date.now(), start: cfg.start, end: cfg.end, mode: cfg.mode, minutes: cfg.minutes });
    }

    // Find students by name, school, county, candidate number or code.
    if (action === 'search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return send(res, 200, { rows: [] });
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      const codeLike = '%' + normCode(q) + '%';
      const rows = await sql`
        select s.code, s.name, s.school, s.county, s.candidate_no,
               x.first_join_at, x.last_sync_at, x.submitted_at, x.join_count
        from students s left join sessions x using (code)
        where s.name ilike ${like} or s.school ilike ${like} or s.county ilike ${like}
           or s.candidate_no ilike ${like} or (length(${normCode(q)}) >= 3 and s.code like ${codeLike})
        order by s.name limit 50`;
      return send(res, 200, { rows: rows.map(r => ({ ...r, pretty: prettyCode(r.code) })) });
    }

    // Issue a new code on the spot (late registration, lost code). POST { name, school, county, candidate_no }
    if (action === 'create') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 200);
      if (!name) return send(res, 400, { error: 'Enter the student\'s name.' });
      for (let i = 0; i < 5; i++) {
        const code = genCode();
        const r = await sql`insert into students (code, name, school, county, candidate_no)
          values (${code}, ${name}, ${String(b.school || '').trim() || null}, ${String(b.county || '').trim() || null}, ${String(b.candidate_no || '').trim() || null})
          on conflict do nothing returning code`;
        if (r.length) return send(res, 200, { code, pretty: prettyCode(code), name });
      }
      return send(res, 500, { error: 'Could not create a code, try again.' });
    }

    // The paper, for the admin preview.
    if (action === 'paper') return send(res, 200, { paper: PAPER, minutes: cfg.minutes });

    if (action === 'devices') {
      const rows = await sql`
        select s.code, s.name, s.school, x.join_count,
               count(distinct j.ip)::int as ips, count(distinct j.ua)::int as browsers
        from sessions x join students s using (code) join joins j using (code)
        group by s.code, s.name, s.school, x.join_count
        having count(distinct j.ip) > 1 or count(distinct j.ua) > 1
            or bool_or(j.kind = 'device_switch')
        order by ips desc, browsers desc limit 200`;
      return send(res, 200, { rows });
    }

    if (action === 'student') {
      const code = normCode(url.searchParams.get('code'));
      const [student] = await sql`select * from students where code = ${code}`;
      if (!student) return send(res, 404, { error: 'No student with that code' });
      const [session] = await sql`select * from sessions where code = ${code}`;
      const joins = await sql`select at, kind, ip, ua from joins where code = ${code} order by at`;
      const logs = await sql`select seq, received_at, base, stale, late, final, events from logs where code = ${code} order by received_at`;
      // Tally event types across batches (format: "dt,type,q,a,b;dt,type,...")
      const counts = {};
      let recent = [];
      for (const l of logs) {
        if (!l.events) continue;
        let t = Number(l.base) || 0;
        for (const e of l.events.split(';')) {
          if (!e) continue;
          const f = e.split(',');
          t += Number(f[0]) || 0;
          counts[f[1]] = (counts[f[1]] || 0) + 1;
          if (f[1] !== 'k') recent.push([t, ...f.slice(1)]);
        }
      }
      recent = recent.slice(-400);
      return send(res, 200, {
        student, session, joins,
        batches: logs.length, stale: logs.filter(l => l.stale).length,
        counts, recent, start: cfg.start,
      });
    }
    // ---- Backups (used by the Google Drive script). Paged to stay under Vercel's 4.5 MB response limit. ----
    if (action === 'backup-sessions') {
      const after = url.searchParams.get('after') || '';
      const rows = await sql`
        select s.code, s.name, s.school, s.county, s.candidate_no,
               x.first_join_at, x.last_join_at, x.join_count, x.last_sync_at, x.sync_count,
               x.late_syncs, x.submitted_at, x.answers
        from students s left join sessions x using (code)
        where s.code > ${after} order by s.code limit 400`;
      return send(res, 200, { rows, next: rows.length === 400 ? rows[rows.length - 1].code : null });
    }

    if (action === 'backup-logs') {
      const after = Number(url.searchParams.get('after') || 0);
      const rows = await sql`
        select id, code, token, seq, received_at, client_now, base, stale, late, final, answers, events
        from logs where id > ${after} order by id limit 1500`;
      const out = []; let size = 0;
      for (const r of rows) {
        const n = JSON.stringify(r).length;
        if (out.length && size + n > 3_500_000) break;
        out.push(r); size += n;
      }
      return send(res, 200, { rows: out, last: out.length ? String(out[out.length - 1].id) : String(after), more: out.length < rows.length || rows.length === 1500 });
    }

    if (action === 'backup-joins') {
      const after = Number(url.searchParams.get('after') || 0);
      const rows = await sql`select id, code, token, kind, at, ip, ua from joins where id > ${after} order by id limit 5000`;
      return send(res, 200, { rows, last: rows.length ? String(rows[rows.length - 1].id) : String(after), more: rows.length === 5000 });
    }

    return send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
}
