// Things the admin page can change without a redeploy: the paper (uploaded .tex), the instructions,
// the event text shown before the paper opens, and logos. Tables are created on first use.
import { PAPER as FILE_PAPER, answerKeysOf } from './paper.js';
import { MCQ_KEY as FILE_KEY, MCQ_POINTS as FILE_POINTS } from './key.js';
import { SAMPLE_PAPER, SAMPLE_KEY, SAMPLE_POINTS } from './sample-paper.js';

// Creates the admin-page tables if they are missing. Safe under heavy concurrency: one cheap check per
// server instance, shared by simultaneous requests, and DDL only runs when something is actually missing.
let ready = null;
export function ensureTables(sql) {
  if (!ready) ready = doEnsure(sql).catch(e => { ready = null; throw e; });
  return ready;
}
async function doEnsure(sql) {
  const [c] = await sql`select
    to_regclass('papers') is not null and to_regclass('settings') is not null and to_regclass('logos') is not null
    and to_regclass('marks') is not null
    and exists (select 1 from information_schema.columns where table_name = 'students' and column_name = 'extra_minutes') as ok`;
  if (c.ok) return;
  const ddl = [
    sql`create table if not exists papers (
      id bigserial primary key, uploaded_at timestamptz default now(), filename text, tex text,
      paper jsonb not null, key jsonb, points jsonb, summary jsonb, active boolean default true)`,
    sql`create table if not exists settings (key text primary key, value jsonb, updated_at timestamptz default now())`,
    sql`create table if not exists logos (
      id bigserial primary key, alt text, mime text, data text, pos int default 0, created_at timestamptz default now())`,
    sql`alter table students add column if not exists extra_minutes int default 0`,
    sql`create table if not exists marks (
      code text not null, problem text not null, score numeric, comment text, marker text,
      claimed_by text, claimed_at timestamptz, updated_at timestamptz default now(), primary key (code, problem))`,
  ];
  for (const q of ddl) {
    try { await q; } catch (e) { if (!['23505', '42P07', '42701'].includes(e.code)) throw e; } // created concurrently elsewhere
  }
}

// Short in-memory cache so 4000 joins at the start don't each read the paper from the database.
let cache = null, cacheAt = 0;
export function clearCache() { cache = null; }

export async function activePaper(sql) {
  if (cache && Date.now() - cacheAt < 30_000) return cache;
  let out = { paper: FILE_PAPER, key: FILE_KEY, points: FILE_POINTS, source: 'built-in', uploadedAt: null, filename: null };
  try {
    await ensureTables(sql);
    const [p] = await sql`select paper, key, points, uploaded_at, filename from papers where active order by id desc limit 1`;
    if (p) out = { paper: p.paper, key: p.key || {}, points: p.points || {}, source: 'uploaded', uploadedAt: p.uploaded_at, filename: p.filename };
    const [ins] = await sql`select value from settings where key = 'instructions'`;
    if (ins?.value?.length) out = { ...out, paper: { ...out.paper, instructions: ins.value } };
  } catch (e) {
    console.error('activePaper: using built-in paper', e.message);
  }
  out.answerKeys = answerKeysOf(out.paper);
  cache = out; cacheAt = Date.now();
  return out;
}

// The paper students actually get. In practice mode that is the sample paper, unless an admin has chosen
// to use the real paper for practice (a deliberate choice on the admin page).
export async function servedPaper(sql, cfg) {
  if (cfg.mode === 'practice' && (await cachedSetting(sql, 'practicePaper', 'sample')) !== 'real') {
    return { paper: SAMPLE_PAPER, key: SAMPLE_KEY, points: SAMPLE_POINTS, source: 'sample', answerKeys: answerKeysOf(SAMPLE_PAPER) };
  }
  return activePaper(sql);
}

// Settings read on every save (announcements) are cached for 20 s per server instance.
const settingCache = new Map();
export async function cachedSetting(sql, key, fallback = null) {
  const c = settingCache.get(key);
  if (c && Date.now() - c.at < 20_000) return c.value;
  const value = await getSetting(sql, key, fallback);
  settingCache.set(key, { value, at: Date.now() });
  return value;
}

export async function getSetting(sql, key, fallback = null) {
  try { await ensureTables(sql); const [r] = await sql`select value from settings where key = ${key}`; return r ? r.value : fallback; }
  catch { return fallback; }
}
export async function setSetting(sql, key, value) {
  await ensureTables(sql);
  await sql`insert into settings (key, value, updated_at) values (${key}, ${sql.json(value)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  clearCache(); settingCache.delete(key);
}
