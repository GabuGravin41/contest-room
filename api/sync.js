// POST /api/sync  { code, token, seq, ans:{key:value}, ev:"compact events", base, clientNow, snap, final }
// Saves changed answers and appends one activity-log batch. Idempotent per (code, token, seq).
import { config, windowFor, db, readBody, send, normCode } from '../lib/server.js';
import { activePaper } from '../lib/store.js';

const MAX_ANSWER = 20000;       // characters per answer box
const MAX_EVENTS = 1_500_000;   // characters of log per batch

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const cfg = config();
    const sql = db();
    const b = await readBody(req);
    const code = normCode(b.code);
    const tok = String(b.token || '');
    const seq = Number.isInteger(b.seq) ? b.seq : -1;
    const now = Date.now();
    if (!code || !tok || seq < 0) return send(res, 400, { error: 'Bad request' });

    const [s] = await sql`select active_token, submitted_at, first_join_at from sessions where code = ${code}`;
    if (!s) return send(res, 404, { error: 'Unknown session' });

    const stale = s.active_token !== tok;          // code was opened on another device later
    const w = windowFor(cfg, s.first_join_at, now);
    const late = now > w.end;
    const closed = now > w.end + cfg.graceMs;
    const final = !!b.final;

    const { answerKeys } = await activePaper(sql);
    const ans = {};
    if (b.ans && typeof b.ans === 'object') {
      for (const [k, v] of Object.entries(b.ans)) {
        if (answerKeys.has(k) && typeof v === 'string') ans[k] = v.slice(0, MAX_ANSWER);
      }
    }
    const hasAns = Object.keys(ans).length > 0;
    const ev = typeof b.ev === 'string' ? b.ev.slice(0, MAX_EVENTS) : '';

    const inserted = await sql`
      insert into logs (code, token, seq, client_now, base, stale, late, final, answers, events)
      values (${code}, ${tok}, ${seq}, ${Number(b.clientNow) || null}, ${Number(b.base) || null},
              ${stale}, ${late}, ${final}, ${(b.snap || final) && hasAns ? sql.json(ans) : null}, ${ev})
      on conflict (code, token, seq) do nothing
      returning id`;

    let submitted = !!s.submitted_at;
    if (inserted.length && !stale && !closed && !submitted) {
      await sql`
        update sessions set
          answers = case when ${hasAns} then answers || ${sql.json(ans)} else answers end,
          answers_updated_at = case when ${hasAns} then now() else answers_updated_at end,
          last_sync_at = now(),
          sync_count = sync_count + 1,
          late_syncs = late_syncs + ${late ? 1 : 0},
          submitted_at = case when ${final} then now() else submitted_at end
        where code = ${code}`;
      if (final) submitted = true;
    }

    return send(res, 200, { ok: true, serverNow: now, superseded: stale, closed, submitted, end: w.end });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Server error' });
  }
}
