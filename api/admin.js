// /api/admin?action=...   (header: x-admin-key). Monitor, students and codes, contest content, safety tools.
// Bulk exports of answers and logs are done with `npm run export` (too large for a serverless response).
import { config, db, send, normCode, readBody, genCode, prettyCode, keyOk } from '../lib/server.js';
import { PAPER } from '../lib/paper.js';
import { convert } from '../lib/tex.js';
import { ensureTables, activePaper, getSetting, setSetting, clearCache } from '../lib/store.js';

const LIVE_WINDOW = cfg => cfg.mode === 'live' && Date.now() >= cfg.start - 30 * 60_000 && Date.now() <= cfg.end + 4 * 3600_000;

export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY) return send(res, 500, { error: 'ADMIN_KEY is not set in Vercel.' });
  if (!(await keyOk(req.headers['x-admin-key'], process.env.ADMIN_KEY))) return send(res, 401, { error: 'Wrong admin key' });
  try {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || 'stats';
    const minutes = Number(process.env.CONTEST_MINUTES || 150);
    // The paper, for the admin preview. Falls back to the built-in paper if the database isn't set up.
    if (action === 'paper') {
      let paper = PAPER;
      try { paper = (await activePaper(db())).paper; } catch { }
      return send(res, 200, { paper, minutes });
    }
    const sql = db();
    const cfg = config();

    // ---- Branding, instructions and paper (for non-technical admins) ----
    if (action === 'settings') {
      await ensureTables(sql);
      const ap = await activePaper(sql);
      const logos = await sql`select id, alt from logos order by pos, id`;
      const all = ap.paper.sections.flatMap(x => x.problems);
      return send(res, 200, {
        brand: await getSetting(sql, 'brand', {}),
        instructions: ap.paper.instructions,
        logos: logos.map(l => ({ id: String(l.id), alt: l.alt })),
        paper: { source: ap.source, filename: ap.filename, uploadedAt: ap.uploadedAt, title: ap.paper.title, round: ap.paper.round,
          problems: all.length, marks: all.reduce((t, p) => t + p.marks, 0), mcqKey: Object.keys(ap.key || {}).length },
        contestLive: cfg.mode === 'live' && Date.now() >= cfg.start - 30 * 60_000 && Date.now() <= cfg.end + cfg.graceMs,
        mode: cfg.mode, practicePaper: await getSetting(sql, 'practicePaper', 'sample'),
        announcement: await getSetting(sql, 'announcement', null),
      });
    }

    // ---- Readiness checklist for contest day ----
    if (action === 'readiness') {
      await ensureTables(sql);
      const ap = await activePaper(sql);
      const mcqs = ap.paper.sections.flatMap(x => x.problems).filter(p => p.type === 'mcq');
      const missing = mcqs.filter(p => !(ap.key || {})[p.id]).map(p => p.id);
      const [c] = await sql`select (select count(*) from students)::int as students, (select count(*) from sessions)::int as sessions,
        (select count(*) from logs)::int as logs, (select count(*) from marks)::int as marks,
        (select pg_database_size(current_database()))::bigint as bytes`;
      const ann = await getSetting(sql, 'announcement', null);
      const now = Date.now(), adminKey = process.env.ADMIN_KEY || '', markerKey = process.env.MARKER_KEY || '';
      const fmt = t => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }) + ' EAT';
      const checks = [
        cfg.mode === 'live' ? { ok: true, label: 'Live mode is on' } : { ok: false, label: 'Practice mode is on', detail: 'Set CONTEST_MODE=live in Vercel and redeploy before the contest.' },
        cfg.mode === 'live' && cfg.start > now ? { ok: true, label: `Start time: ${fmt(cfg.start)}`, detail: `Ends ${fmt(cfg.end)} (${cfg.minutes} minutes).` }
          : cfg.mode === 'live' && now <= cfg.end ? { ok: true, label: 'The contest is running', detail: `Ends ${fmt(cfg.end)}.` }
          : { ok: false, label: 'Start time', detail: cfg.mode === 'live' ? 'CONTEST_START is in the past. Set the real start time in Vercel and redeploy.' : 'Set CONTEST_START (e.g. 2026-10-10T09:00:00+03:00) in Vercel.' },
        { ok: ap.source === 'uploaded' || ap.paper.sections.length > 0, label: `Paper: ${ap.paper.title} · ${ap.paper.round}`, detail: ap.source === 'uploaded' ? `Uploaded ${fmt(ap.uploadedAt)} from ${ap.filename || 'a .tex file'}.` : 'Built-in paper from the repository. Upload the final .tex if it has changed.' },
        missing.length ? { ok: false, label: 'Section A answer key incomplete', detail: `No answer for problems ${missing.join(', ')}.` } : { ok: true, label: `Section A answer key complete (${mcqs.length} problems)` },
        { ok: c.students > 0, label: `${c.students} students registered`, detail: c.students ? '' : 'Import the student list under Students and codes.' },
        cfg.mode === 'live' && cfg.start > now && (c.sessions || c.logs)
          ? { ok: false, label: 'Test data present', detail: `${c.sessions} students have already entered and ${c.logs} log batches exist, from demos or rehearsals. Clear them under Safety tools.` }
          : { ok: true, label: 'No leftover test data', detail: '' },
        process.env.FALLBACK_EMAIL ? { ok: true, label: `Fallback email: ${process.env.FALLBACK_EMAIL}` } : { ok: false, label: 'No fallback email', detail: 'Set FALLBACK_EMAIL in Vercel so students know where to send saved answers if the site is down.' },
        adminKey.length >= 20 ? { ok: true, label: 'Admin key is long enough' } : { ok: false, label: 'Admin key is short', detail: 'Use at least 20 random characters for ADMIN_KEY.' },
        markerKey && markerKey !== adminKey ? { ok: true, label: 'Separate marker key is set' } : { ok: 'warn', label: 'No separate marker key', detail: 'Set MARKER_KEY in Vercel so markers can mark without admin access.' },
        ann?.text ? { ok: 'warn', label: 'An announcement is showing', detail: `"${ann.text}". Clear it if it is old.` } : { ok: true, label: 'No announcement showing' },
        { ok: Number(c.bytes) < 400e6 ? true : 'warn', label: `Database size ${(Number(c.bytes) / 1e6).toFixed(0)} MB`, detail: Number(c.bytes) < 400e6 ? '' : 'Close to the 0.5 GB free limit.' },
      ];
      return send(res, 200, { checks });
    }

    // ---- All students with codes (for mail-merge / SMS) ----
    if (action === 'codes') {
      const rows = await sql`select s.code, s.name, s.school, s.county, s.candidate_no, s.extra_minutes, x.first_join_at, x.submitted_at
        from students s left join sessions x using (code) order by s.school, s.name`;
      return send(res, 200, { rows: rows.map(r => ({ ...r, pretty: prettyCode(r.code) })), start: cfg.start, mode: cfg.mode });
    }
    if (req.method === 'POST' && ['announce', 'practice-paper', 'extra-time', 'import', 'reset'].includes(action)) {
      await ensureTables(sql);
      const b = await readBody(req);
      if (action === 'announce') {
        const text = String(b.text || '').trim().slice(0, 500);
        await setSetting(sql, 'announcement', text ? { text, at: Date.now() } : { text: '', at: Date.now() });
        return send(res, 200, { ok: true });
      }
      if (action === 'practice-paper') {
        await setSetting(sql, 'practicePaper', b.which === 'real' ? 'real' : 'sample');
        return send(res, 200, { ok: true });
      }
      if (action === 'extra-time') {
        const m = Math.max(0, Math.min(240, Math.round(Number(b.minutes) || 0)));
        const r = await sql`update students set extra_minutes = ${m} where code = ${normCode(b.code)} returning code`;
        if (!r.length) return send(res, 404, { error: 'No student with that code' });
        return send(res, 200, { ok: true, minutes: m });
      }
      if (action === 'import') {
        const rows = Array.isArray(b.rows) ? b.rows.slice(0, 1000) : [];
        const out = [];
        for (const p of rows) {
          const name = String(p.name || '').trim().slice(0, 200);
          if (!name) continue;
          for (let i = 0; i < 5; i++) {
            const code = genCode();
            const r = await sql`insert into students (code, name, school, county, candidate_no, extra_minutes)
              values (${code}, ${name}, ${String(p.school || '').trim() || null}, ${String(p.county || '').trim() || null},
                      ${String(p.candidate_no || '').trim() || null}, ${Math.max(0, Math.min(240, Number(p.extra_minutes) || 0))})
              on conflict do nothing returning code`;
            if (r.length) { out.push({ ...p, name, code: prettyCode(code) }); break; }
          }
        }
        return send(res, 200, { ok: true, created: out });
      }
      if (action === 'reset') {
        if (LIVE_WINDOW(cfg)) return send(res, 409, { error: 'Clearing data is switched off from 30 minutes before the start until 4 hours after the end of the live contest.' });
        const scope = ['activity', 'students', 'logs-only'].includes(b.scope) ? b.scope : 'activity';
        const afterLive = cfg.mode === 'live' && Date.now() > cfg.end && scope !== 'logs-only';
        const need = afterLive ? 'DELETE RESULTS' : 'DELETE';
        if (b.confirm !== need) return send(res, 400, { error: afterLive ? 'The live contest has ended, so this would delete real results. Type DELETE RESULTS to confirm.' : 'Type DELETE to confirm.' });
        if (scope === 'logs-only') {
          await sql`update logs set events = null, answers = null`; await sql`update joins set ip = null, ua = null`;
          return send(res, 200, { ok: true, cleared: 'Activity logs and IP/browser details erased. Answers and marks kept.' });
        }
        await sql`delete from marks`; await sql`delete from logs`; await sql`delete from joins`; await sql`delete from sessions`;
        if (scope === 'students') await sql`delete from students`;
        return send(res, 200, { ok: true, cleared: scope === 'students' ? 'All students, codes, answers, logs and marks deleted.' : 'All answers, logs, joins and marks deleted. Students and codes kept.' });
      }
    }

    if (req.method === 'POST' && ['brand-save', 'instructions-save', 'logo-upload', 'logo-delete', 'logo-move', 'paper-upload', 'paper-revert'].includes(action)) {
      await ensureTables(sql);
      const b = await readBody(req);
      // Changing the paper while students are writing would break their answers.
      const live = cfg.mode === 'live' && Date.now() >= cfg.start - 30 * 60_000 && Date.now() <= cfg.end + cfg.graceMs;
      if ((action === 'paper-upload' || action === 'paper-revert') && live && !b.force)
        return send(res, 409, { error: 'The contest is about to start or is running. Changing the paper now would affect students who are writing. Tick "I understand" to do it anyway.' });

      if (action === 'brand-save') {
        const clean = v => String(v || '').trim().slice(0, 200);
        await setSetting(sql, 'brand', { event: clean(b.event), round: clean(b.round), details: clean(b.details) });
        return send(res, 200, { ok: true });
      }
      if (action === 'instructions-save') {
        const lines = String(b.text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 40).map(l => l.slice(0, 1000));
        await setSetting(sql, 'instructions', lines);
        return send(res, 200, { ok: true, count: lines.length });
      }
      if (action === 'logo-upload') {
        const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
        if (!m) return send(res, 400, { error: 'Upload a PNG or JPEG image.' });
        if (m[2].length > 700_000) return send(res, 400, { error: 'That image is too large even after resizing. Try a smaller file.' });
        const [{ n }] = await sql`select coalesce(max(pos), 0) + 1 as n from logos`;
        const [r] = await sql`insert into logos (alt, mime, data, pos) values (${String(b.alt || '').slice(0, 120)}, ${m[1]}, ${m[2]}, ${n}) returning id`;
        return send(res, 200, { ok: true, id: String(r.id) });
      }
      if (action === 'logo-delete') { await sql`delete from logos where id = ${Number(b.id) || 0}`; return send(res, 200, { ok: true }); }
      if (action === 'logo-move') {
        const rows = await sql`select id from logos order by pos, id`;
        const ids = rows.map(r => String(r.id)); const i = ids.indexOf(String(b.id)); const j = i + (b.dir === 'left' ? -1 : 1);
        if (i >= 0 && j >= 0 && j < ids.length) { [ids[i], ids[j]] = [ids[j], ids[i]]; for (let k = 0; k < ids.length; k++) await sql`update logos set pos = ${k} where id = ${ids[k]}`; }
        return send(res, 200, { ok: true });
      }
      if (action === 'paper-upload') {
        const tex = String(b.tex || '');
        if (!tex.includes('\\begin{document}')) return send(res, 400, { error: 'That does not look like a LaTeX file (no \\begin{document}).' });
        let out;
        try { out = convert(tex, { instructions: PAPER.instructions, id: String(b.filename || 'uploaded').replace(/\.tex$/i, '') }); }
        catch (e) { return send(res, 400, { error: 'Could not read the paper: ' + e.message }); }
        if (!out.summary.problems) return send(res, 400, { error: 'No problems found. Each problem must be inside \\begin{problem}{marks} … \\end{problem}.' });
        if (b.check) return send(res, 200, { ok: true, checked: true, summary: out.summary, warnings: out.warnings });
        await sql`update papers set active = false where active`;
        await sql`insert into papers (filename, tex, paper, key, points, summary, active)
          values (${String(b.filename || '').slice(0, 200)}, ${tex}, ${sql.json(out.paper)}, ${sql.json(out.key)}, ${sql.json(out.points)}, ${sql.json(out.summary)}, true)`;
        clearCache();
        return send(res, 200, { ok: true, summary: out.summary, warnings: out.warnings });
      }
      if (action === 'paper-revert') { await sql`update papers set active = false where active`; clearCache(); return send(res, 200, { ok: true }); }
    }

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
