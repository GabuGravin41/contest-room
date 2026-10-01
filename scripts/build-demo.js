// Builds out/demo.html: the student app with a fake in-browser server, for the team to click through.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PAPER } from '../lib/paper.js';

const css = readFileSync('public/styles.css', 'utf8');
const app = readFileSync('public/app.js', 'utf8');
const mock = `
window.CR_DEMO = true;
(() => {
  const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const PAPER = ${JSON.stringify(PAPER)};
  let start = get('demo:start');
  if (!start || Date.now() > start + 150 * 60000) { start = Date.now() + 20000; set('demo:start', start); }
  const student = code => ({ name: 'Demo Student', school: 'Your School', county: 'Nairobi', candidateNo: 'KIO-0000', code });
  window.CR_API = async (path, b) => {
    await new Promise(r => setTimeout(r, 250));
    const now = Date.now(), end = start + 150 * 60000;
    const base = { serverNow: now, start, end, syncSeconds: 20 };
    if (path === 'join') {
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (get('demo:submitted')) return { ...base, status: 'submitted', student: student(code), submittedAt: get('demo:submitted') };
      if (now < start) return { ...base, status: 'waiting', student: student(code) };
      const tok = b.token || 'demo-' + Math.random().toString(36).slice(2);
      return { ...base, status: 'open', student: student(code), token: tok, kind: b.token ? 'resume' : 'new', paper: PAPER, answers: get('demo:answers') || {} };
    }
    if (path === 'sync') {
      set('demo:answers', { ...(get('demo:answers') || {}), ...(b.ans || {}) });
      if (b.final) set('demo:submitted', now);
      return { ok: true, serverNow: now, superseded: false, closed: false, submitted: !!b.final, end };
    }
  };
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-reset]')) return;
    try { Object.keys(localStorage).filter(k => k.startsWith('cr:') || k.startsWith('demo:')).forEach(k => localStorage.removeItem(k)); } catch {}
    location.reload();
  });
})();`;
const html = `<title>The Contest Room</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap">
<style>
${css}
html, body { height: 100%; }
</style>
<div id="app" style="height:100%"></div>
<script>${mock}</script>
<script>${app}</script>
`;
mkdirSync('out', { recursive: true });
writeFileSync('out/demo.html', html);
console.log('Wrote out/demo.html');
