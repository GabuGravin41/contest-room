// Local stand-in for Vercel: serves ./public and runs ./api/*.js. `npm run dev`, then open http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PORT = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (m) {
    try { const mod = await import(`./api/${m[1]}.js`); return await mod.default(req, res); }
    catch (e) { console.error(e); res.statusCode = 404; return res.end('not found'); }
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!extname(p)) p += '.html';
  try {
    const file = await readFile(join('public', normalize(p).replace(/^(\.\.[/\\])+/, '')));
    res.setHeader('Content-Type', TYPES[extname(p)] || 'application/octet-stream');
    res.end(file);
  } catch { res.statusCode = 404; res.end('not found'); }
}).listen(PORT, () => console.log(`The Contest Room on http://localhost:${PORT}`));
