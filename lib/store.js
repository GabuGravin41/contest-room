// Things the admin page can change without a redeploy: the paper (uploaded .tex), the instructions,
// the event text shown before the paper opens, and logos. Tables are created on first use.
import { PAPER as FILE_PAPER, answerKeysOf } from './paper.js';
import { MCQ_KEY as FILE_KEY, MCQ_POINTS as FILE_POINTS } from './key.js';

let tablesReady = false;
export async function ensureTables(sql) {
  if (tablesReady) return;
  await sql`create table if not exists papers (
    id bigserial primary key, uploaded_at timestamptz default now(), filename text, tex text,
    paper jsonb not null, key jsonb, points jsonb, summary jsonb, active boolean default true)`;
  await sql`create table if not exists settings (key text primary key, value jsonb, updated_at timestamptz default now())`;
  await sql`create table if not exists logos (
    id bigserial primary key, alt text, mime text, data text, pos int default 0, created_at timestamptz default now())`;
  tablesReady = true;
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

export async function getSetting(sql, key, fallback = null) {
  try { await ensureTables(sql); const [r] = await sql`select value from settings where key = ${key}`; return r ? r.value : fallback; }
  catch { return fallback; }
}
export async function setSetting(sql, key, value) {
  await ensureTables(sql);
  await sql`insert into settings (key, value, updated_at) values (${key}, ${sql.json(value)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  clearCache();
}
