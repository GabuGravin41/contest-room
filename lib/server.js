// Shared server helpers: config, database, request/response utilities.
import postgres from 'postgres';

export function config() {
  const start = Date.parse(process.env.CONTEST_START || '');
  if (Number.isNaN(start)) throw new Error('CONTEST_START is not set (use ISO time with offset, e.g. 2026-10-10T09:00:00+03:00)');
  const minutes = Number(process.env.CONTEST_MINUTES || 150);
  const end = start + minutes * 60_000;
  const joinUntilMin = process.env.JOIN_UNTIL_MINUTES ? Number(process.env.JOIN_UNTIL_MINUTES) : null;
  return {
    start,
    end,
    minutes,
    graceMs: Number(process.env.GRACE_SECONDS || 120) * 1000, // late syncs still accepted (network lag)
    joinUntil: joinUntilMin == null ? end : start + joinUntilMin * 60_000,
    syncSeconds: Number(process.env.SYNC_SECONDS || 60),
  };
}

let _sql;
export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const local = /localhost|127\.0\.0\.1/.test(url);
    _sql = postgres(url, {
      max: Number(process.env.DB_POOL || 3),
      prepare: false,          // required for Neon's pooled (pgbouncer) endpoint
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: local ? false : 'require',
    });
  }
  return _sql;
}

export async function readBody(req) {
  let b = req.body;
  if (b === undefined) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    b = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { return b ? JSON.parse(b) : {}; } catch { return {}; }
  }
  return b || {};
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export function clientInfo(req) {
  const h = req.headers || {};
  const ip = String(h['x-forwarded-for'] || h['x-real-ip'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  return { ip, ua: String(h['user-agent'] || '').slice(0, 400) };
}

// Codes are stored without separators, upper-case: "KIO7F3KQ9PX" is typed as "KIO-7F3K-Q9PX".
export const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);

export function token() {
  return crypto.randomUUID().replace(/-/g, '');
}
