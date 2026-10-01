// GET /api/brand            → { brand: {event, round, details}, logos: [{id, alt}] }  (public, cached by Vercel's CDN)
// GET /api/brand?logo=ID    → the logo image
import { db, send } from '../lib/server.js';
import { ensureTables, getSetting } from '../lib/store.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    const sql = db();
    await ensureTables(sql);
    const id = url.searchParams.get('logo');
    if (id) {
      const [l] = await sql`select mime, data from logos where id = ${Number(id) || 0}`;
      if (!l) { res.statusCode = 404; return res.end(); }
      res.statusCode = 200;
      res.setHeader('Content-Type', l.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, immutable'); // a new upload gets a new id
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.end(Buffer.from(l.data, 'base64'));
    }
    const brand = await getSetting(sql, 'brand', {});
    const logos = await sql`select id, alt from logos order by pos, id`;
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    return send(res, 200, { brand, logos: logos.map(l => ({ id: String(l.id), alt: l.alt || '' })) }, true);
  } catch (e) {
    console.error(e);
    return send(res, 200, { brand: {}, logos: [] }); // the page falls back to public/branding.js
  }
}
