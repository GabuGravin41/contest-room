// POST /api/join  { code, token? }
// Before the start: returns the waiting-room info (no paper).
// During the window: issues/resumes a session token and returns the paper + saved answers.
import { config, windowFor, db, readBody, send, clientInfo, normCode, token as newToken } from '../lib/server.js';
import { PAPER } from '../lib/paper.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const cfg = config();
    const sql = db();
    const body = await readBody(req);
    const code = normCode(body.code);
    const now = Date.now();
    
    if (code.length < 6) return send(res, 400, { error: 'Enter the contest code you were sent.' });

    const [row] = await sql`
      select s.code, s.name, s.school, s.county, s.candidate_no,
             x.active_token, x.submitted_at, x.answers, x.first_join_at
      from students s left join sessions x on x.code = s.code
      where s.code = ${code}`;
    if (!row) return send(res, 404, { error: 'We could not find that code. Check it against the message you were sent.' });

    const w = windowFor(cfg, row.first_join_at, now);
    const base = { serverNow: now, start: w.start, end: w.end, syncSeconds: cfg.syncSeconds, mode: cfg.mode, fallbackEmail: cfg.fallbackEmail };
    const student = { name: row.name, school: row.school, county: row.county, candidateNo: row.candidate_no, code };

    if (row.submitted_at) return send(res, 200, { ...base, status: 'submitted', student, submittedAt: +new Date(row.submitted_at) });
    if (now < w.start) return send(res, 200, { ...base, status: 'waiting', student });
    if (now > w.end) return send(res, 200, { ...base, status: 'closed', student });

    const { ip, ua } = clientInfo(req);
    const resumed = !!(body.token && row.active_token && body.token === row.active_token);

    if (!resumed && !row.active_token && now > w.joinUntil) {
      return send(res, 200, { ...base, status: 'join_closed', student });
    }

    const tok = resumed ? row.active_token : newToken();
    const kind = resumed ? 'resume' : (row.active_token ? 'device_switch' : 'new');

    await sql`
      insert into sessions (code, active_token, first_join_at, last_join_at, join_count)
      values (${code}, ${tok}, now(), now(), 1)
      on conflict (code) do update set
        active_token = excluded.active_token,
        last_join_at = now(),
        join_count = sessions.join_count + 1`;
    await sql`insert into joins (code, token, kind, ip, ua) values (${code}, ${tok}, ${kind}, ${ip}, ${ua})`;

    return send(res, 200, {
      ...base, status: 'open', student, token: tok, kind,
      paper: PAPER, answers: row.answers || {},
    });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'The server had a problem. Wait a few seconds and try again.' });
  }
}
