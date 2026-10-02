// Marking for written (Section B) and algorithm (Section C) answers.  Header: x-marker-key (MARKER_KEY or ADMIN_KEY).
//   GET  ?action=overview                 problems, marks available, progress, Section A cut-off
//   GET  ?action=next&problem=8&marker=X  claims the next unmarked script for this problem (anonymous)
//   GET  ?action=script&sid=...&problem=8 re-open a script (to correct a mark)
//   GET  ?action=mine&problem=8&marker=X  the marker's last 30 marked scripts
//   POST ?action=save   { sid, problem, score, comment, marker }
//   POST ?action=skip   { sid, problem }
//   POST ?action=cutoff { min }           (admin key only) only mark students with Section A score >= min
// Markers never see names, schools or codes: scripts are identified by an encrypted id.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config, db, send, readBody, keyOk } from '../lib/server.js';
import { ensureTables, servedPaper, getSetting, setSetting } from '../lib/store.js';

const secret = () => createHash('sha256').update('kio-mark:' + (process.env.ADMIN_KEY || '')).digest();
const sidOf = code => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', secret(), iv); const enc = Buffer.concat([c.update(code, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url'); };
const codeOf = sid => { try { const b = Buffer.from(String(sid), 'base64url'); const d = createDecipheriv('aes-256-gcm', secret(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); } catch { return null; } };
// A short, stable label markers can quote ("script 4F2A9C") without revealing the code.
const label = code => createHash('sha256').update('label:' + code + (process.env.ADMIN_KEY || '')).digest('hex').slice(0, 6).toUpperCase();

export default async function handler(req, res) {
  const given = req.headers['x-marker-key'];
  const isAdmin = await keyOk(given, process.env.ADMIN_KEY);
  if (!isAdmin && !(await keyOk(given, process.env.MARKER_KEY))) return send(res, 401, { error: 'Wrong marker key' });
  try {
    const sql = db(); const cfg = config();
    await ensureTables(sql);
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || 'overview';
    const { paper, key, points } = await servedPaper(sql, cfg);
    const markable = paper.sections.flatMap(s => s.problems.map(p => ({ ...p, sec: s.id }))).filter(p => p.type !== 'mcq');
    const keysOf = p => (p.type === 'written' ? p.parts.map(pt => p.id + pt.id) : [p.id]);
    const minA = Number(await getSetting(sql, 'markingMinA', 0)) || 0;

    // Section A score as SQL, from the answer key
    let secA = sql`0`;
    for (const [q, k] of Object.entries(key || {})) secA = sql`${secA} + (case when x.answers->>${q} = ${k} then ${Number(points?.[q] ?? 2)} else 0 end)`;
    const hasAnswer = p => { let e = sql`0`; for (const k of keysOf(p)) e = sql`${e} + coalesce(length(trim(x.answers->>${k})), 0)`; return sql`(${e}) > 0`; };
    const eligible = p => sql`x.first_join_at is not null and (${secA}) >= ${minA} and ${hasAnswer(p)}`;
    const find = id => markable.find(p => p.id === String(id));

    if (action === 'overview') {
      const out = [];
      for (const p of markable) {
        const [r] = await sql`select count(*)::int as total, count(m.score)::int as marked
          from sessions x left join marks m on m.code = x.code and m.problem = ${p.id} where ${eligible(p)}`;
        out.push({ id: p.id, section: p.sec, marks: p.marks, total: r.total, marked: r.marked });
      }
      return send(res, 200, { problems: out, minA, isAdmin, paperTitle: `${paper.title} · ${paper.round}` });
    }

    const scriptFor = async (code, p) => {
      const [x] = await sql`select answers from sessions where code = ${code}`;
      const [m] = await sql`select score, comment, marker from marks where code = ${code} and problem = ${p.id}`;
      return { sid: sidOf(code), label: label(code), problem: p, answers: Object.fromEntries(keysOf(p).map(k => [k, x?.answers?.[k] || ''])), mark: m || null };
    };

    if (action === 'next') {
      const p = find(url.searchParams.get('problem')); if (!p) return send(res, 400, { error: 'Unknown problem' });
      const marker = String(url.searchParams.get('marker') || '').slice(0, 60) || 'marker';
      // claim one unmarked script atomically; stale claims (15 min) are released
      const [r] = await sql`
        with pick as (
          select x.code from sessions x left join marks m on m.code = x.code and m.problem = ${p.id}
          where ${eligible(p)} and m.score is null
            and (m.claimed_at is null or m.claimed_at < now() - interval '15 minutes' or m.claimed_by = ${marker})
          order by (m.claimed_by = ${marker}) desc nulls last, random() limit 1 for update of x skip locked)
        insert into marks (code, problem, claimed_by, claimed_at) select code, ${p.id}, ${marker}, now() from pick
        on conflict (code, problem) do update set claimed_by = excluded.claimed_by, claimed_at = now()
        returning code`;
      const [left] = await sql`select count(*)::int as n from sessions x left join marks m on m.code = x.code and m.problem = ${p.id} where ${eligible(p)} and m.score is null`;
      if (!r) return send(res, 200, { done: true, remaining: left.n });
      return send(res, 200, { ...(await scriptFor(r.code, p)), remaining: left.n });
    }

    if (action === 'script') {
      const p = find(url.searchParams.get('problem')); const code = codeOf(url.searchParams.get('sid'));
      if (!p || !code) return send(res, 400, { error: 'Unknown script' });
      return send(res, 200, await scriptFor(code, p));
    }

    if (action === 'mine') {
      const p = find(url.searchParams.get('problem')); if (!p) return send(res, 400, { error: 'Unknown problem' });
      const rows = await sql`select code, score, updated_at from marks where problem = ${p.id} and marker = ${String(url.searchParams.get('marker') || '')} and score is not null order by updated_at desc limit 30`;
      return send(res, 200, { rows: rows.map(r => ({ sid: sidOf(r.code), label: label(r.code), score: Number(r.score), at: r.updated_at })) });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      if (action === 'cutoff') {
        if (!isAdmin) return send(res, 403, { error: 'Only an admin can change the cut-off.' });
        await setSetting(sql, 'markingMinA', Math.max(0, Number(b.min) || 0));
        return send(res, 200, { ok: true });
      }
      const p = find(b.problem); const code = codeOf(b.sid);
      if (!p || !code) return send(res, 400, { error: 'Unknown script' });
      if (action === 'save') {
        const score = Number(b.score);
        if (!Number.isFinite(score) || score < 0 || score > p.marks || Math.round(score * 2) !== score * 2)
          return send(res, 400, { error: `Enter a mark from 0 to ${p.marks} (halves allowed).` });
        await sql`insert into marks (code, problem, score, comment, marker, updated_at) values (${code}, ${p.id}, ${score}, ${String(b.comment || '').slice(0, 1000)}, ${String(b.marker || '').slice(0, 60)}, now())
          on conflict (code, problem) do update set score = excluded.score, comment = excluded.comment, marker = excluded.marker, updated_at = now(), claimed_by = null`;
        return send(res, 200, { ok: true });
      }
      if (action === 'skip') {
        await sql`update marks set claimed_by = null, claimed_at = null where code = ${code} and problem = ${p.id} and score is null`;
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
}
