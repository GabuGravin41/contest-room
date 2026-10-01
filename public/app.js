/* The Contest Room — student client.
   Answers and the activity log are kept in memory and in localStorage, and sent to /api/sync every
   `syncSeconds` (plus on submit and when the page closes). Nothing is lost on reload or a dropped connection. */
(async () => {
  'use strict';
  const app = document.getElementById('app');
  const DEMO = !!window.CR_DEMO;
  const PREVIEW = /[?&]preview\b/.test(location.search);
  const SHOWLOG = DEMO || PREVIEW;
  // Text and logos for the screens shown before the paper opens. Edit public/branding.js.
  const B = Object.assign({ name: 'The Contest Room', event: 'Kenya Informatics Olympiad 2026', round: 'Round 1', details: '2 hours 30 minutes · 20 problems · 100 marks', logos: [] }, window.CR_BRAND || {});

  // ---------- small utilities ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { } },
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');
  const hms = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
  const eat = t => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' }) + ' EAT';
  const eatDate = t => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'long', day: 'numeric', month: 'long' });
  const prettyCode = c => { c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return [c.slice(0, 3), c.slice(3, 7), c.slice(7, 11)].filter(Boolean).join('-'); };
  const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function api(path, body, opts = {}) {
    if (window.CR_API) return window.CR_API(path, body);
    const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: !!opts.keepalive });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Could not reach the server.'); e.status = r.status; throw e; }
    return j;
  }

  let toastTimer;
  function toast(msg, ms = 4000) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- inline maths: a small TeX subset inside $...$ ----------
  const SYM = { le: '≤', ge: '≥', ne: '≠', cdot: '·', times: '×', oplus: '⊕', leftrightarrow: '↔', mid: '∣', to: '→' };
  const PLAIN = { dots: '…', ldots: '…', pounds: '£', lceil: '⌈', rceil: '⌉', omega: 'ω', infty: '∞' };
  const OPS = new Set(['gcd', 'max', 'min', 'log', 'lcm']);
  function tex(s) {
    let i = 0;
    const raw = () => { while (s[i] === ' ') i++; if (s[i] !== '{') return s[i++] || ''; let d = 0, r = ''; i++; while (i < s.length) { if (s[i] === '{') d++; if (s[i] === '}' && d-- === 0) break; r += s[i++]; } i++; return r; };
    function atom() {
      const c = s[i];
      if (c === '{') { i++; let r = ''; while (i < s.length && s[i] !== '}') r += atom(); i++; return r; }
      if (c === '\\') {
        i++; let name = '';
        while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++];
        if (!name) { const ch = s[i++]; return ch === ',' ? '&thinsp;' : esc(ch); }
        if (name === 'texttt') return '<code>' + esc(raw()) + '</code>';
        if (name === 'text' || name === 'mathrm') return '<span class="rm">' + esc(raw()) + '</span>';
        if (name === 'tfrac' || name === 'frac') { const a = atom(), b = atom(); return a === '1' && b === '2' ? '½' : `<sup>${a}</sup>⁄<sub>${b}</sub>`; }
        if (name === 'sqrt') return '√' + atom();
        if (OPS.has(name)) return '<span class="rm">' + name + '</span>';
        if (SYM[name]) return ' ' + SYM[name] + ' ';
        if (PLAIN[name]) return PLAIN[name];
        return esc(name);
      }
      i++;
      if (c === '_' || c === '^') { const a = atom(); return c === '_' ? `<sub>${a}</sub>` : `<sup>${a}</sup>`; }
      if (c === ' ') return '';
      if (/[a-zA-Z]/.test(c)) return `<i>${c}</i>`;
      if (c === '<') return ' &lt; ';
      if (c === '>') return ' &gt; ';
      if (c === '=' || c === '+') return ` ${c} `;
      if (c === '-') return ' − ';
      if (c === ',') return ', ';
      return esc(c);
    }
    let out = '';
    while (i < s.length) out += atom();
    return '<span class="math">' + out.replace(/\s{2,}/g, ' ').trim() + '</span>';
  }
  const rich = html => String(html || '').split('$').map((p, k) => (k % 2 ? tex(p) : p)).join('');

  // ---------- state ----------
  const S = {
    code: null, token: null, student: null, start: 0, end: 0, offset: 0, syncSeconds: 60,
    paper: null, answers: {}, dirty: new Set(), flags: new Set(), cur: 'intro',
    events: [], seq: 0, pending: null, inflight: false, syncN: 0,
    locked: false, finalRequested: false, submitted: false, superseded: false,
    lastSaved: null, internalClip: '', lastHideFlush: 0, warned: new Set(),
  };
  const now = () => Date.now() + S.offset;
  const setClock = (serverNow, t0, t1) => { S.offset = serverNow - (t0 + t1) / 2; };
  const skey = () => 'cr:' + S.code;

  function persist() {
    if (!S.code) return;
    store.set(skey(), {
      token: S.token, answers: S.answers, dirty: [...S.dirty], flags: [...S.flags], cur: S.cur,
      events: S.events.slice(-50000), seq: S.seq, pending: S.pending, syncN: S.syncN, finalRequested: S.finalRequested,
    });
  }
  let persistT;
  const persistSoon = () => { clearTimeout(persistT); persistT = setTimeout(persist, 400); };

  // ---------- activity log ----------
  // Each event: [t (ms since official start, server clock), type, question, a, b]
  const clean = v => String(v ?? '').replace(/[,;\n\r]/g, ' ').slice(0, 40);
  function log(type, q = '', a = '', b = '') {
    if (!S.paper || S.submitted || S.superseded) return;
    const e = [Math.round(now() - S.start), type, clean(q), clean(a), clean(b)];
    S.events.push(e);
    if (SHOWLOG) demoLog(e);
    persistSoon();
  }
  function encode(evs) {
    let prev = evs.length ? evs[0][0] : 0;
    const base = prev;
    const parts = evs.map(e => { const dt = e[0] - prev; prev = e[0]; const f = [dt, e[1], e[2], e[3], e[4]]; while (f.length > 2 && f[f.length - 1] === '') f.pop(); return f.join(','); });
    return { base, ev: parts.join(';') };
  }

  // ---------- sync ----------
  function answerKeys() {
    return S.paper.sections.flatMap(s => s.problems.flatMap(p => p.type === 'written' ? p.parts.map(pt => p.id + pt.id) : [p.id]));
  }
  function buildBatch() {
    const ans = {};
    const keys = S.finalRequested ? answerKeys() : [...S.dirty];
    for (const k of keys) if (S.answers[k] != null) ans[k] = S.answers[k];
    S.dirty.clear();
    const { base, ev } = encode(S.events);
    S.events = [];
    S.syncN++;
    return { seq: S.seq++, ans, ev, base, clientNow: Date.now(), snap: S.finalRequested || S.syncN % 5 === 0, final: S.finalRequested };
  }

  async function sync() {
    if (S.inflight || S.superseded || S.submitted || !S.token) return;
    if (!S.pending) {
      if (!S.dirty.size && !S.events.length && !S.finalRequested) { setSave('saved'); return; }
      S.pending = buildBatch();
      persist();
    }
    S.inflight = true; setSave('saving');
    const t0 = Date.now();
    try {
      const r = await api('sync', { code: S.code, token: S.token, ...S.pending });
      setClock(r.serverNow, t0, Date.now());
      const wasFinal = S.pending.final;
      S.pending = null; S.lastSaved = now(); S.failSince = null; persist();
      const eb = document.getElementById('ebanner'); if (eb) eb.hidden = true;
      if (r.superseded) return onSuperseded();
      if (r.submitted && (wasFinal || !S.finalRequested)) return onSubmitted(wasFinal);
      if (r.closed) return onClosed();
      setSave('saved');
    } catch (e) {
      setSave('offline');
      S.failSince = S.failSince || Date.now();
      const eb = document.getElementById('ebanner');
      if (eb && Date.now() - S.failSince > 120_000) eb.hidden = false;
    } finally { S.inflight = false; }
  }

  function flushOnLeave() {
    if (!S.token || S.submitted || S.superseded) return;
    if (!S.pending && (S.dirty.size || S.events.length)) S.pending = buildBatch();
    persist();
    if (!S.pending || DEMO) return;
    const body = JSON.stringify({ code: S.code, token: S.token, ...S.pending });
    if (body.length < 60000 && navigator.sendBeacon) navigator.sendBeacon('/api/sync', body);
    // The batch stays pending; if the beacon landed, resending it later is ignored by the server.
  }

  let syncTimer;
  function startSyncLoop() {
    clearTimeout(syncTimer);
    const every = S.syncSeconds * 1000;
    const tick = async () => { await sync(); syncTimer = setTimeout(tick, every); };
    // Spread thousands of students across the interval instead of all saving at the same second.
    syncTimer = setTimeout(tick, 2000 + Math.random() * every);
  }

  async function requestFinal() {
    S.finalRequested = true; persist();
    const giveUpAt = S.end + 10 * 60_000;
    while (!S.submitted && !S.superseded) {
      await sync();
      if (S.submitted || S.superseded || app.dataset.screen === 'closed') return;
      if (now() > giveUpAt) break;
      await sleep(3000 + Math.random() * 3000);
    }
    if (!S.submitted && !S.superseded) showOverlay('We could not reach the server', 'Your answers are kept on this device. Keep this page open and connected; it will keep trying.', true);
  }

  // ---------- screens ----------
  const ribbon = exam => DEMO ? `<div class="demo-ribbon">Demo mode: nothing leaves this browser. ${exam ? 'The panel at the bottom right shows what the log records.' : 'Any code works, e.g. KIO-DEMO-2026.'} <button class="linkbtn" type="button" data-reset style="color:inherit">Reset demo</button></div>`
    : PREVIEW ? '<div class="demo-ribbon">Admin preview: this is exactly what students see. Nothing is saved and the clock is not real.</div>' : '';
  const logos = cls => B.logos.length ? `<div class="logos ${cls || ''}">${B.logos.map(l => `<img src="${esc(l.src)}" alt="${esc(l.alt || '')}">`).join('')}</div>` : '';
  const shell = (inner, wide) => `<div class="flagline"></div>${ribbon(false)}<main class="gate"><div class="card${wide ? ' wide' : ''}"><div class="card-body">${logos()}${inner}</div></div></main>`;
  const brand = `<div class="brand"><span class="dot"></span>${esc(B.name)}</div>`;

  function screenJoin(prefill = '', err = '') {
    app.dataset.screen = 'join';
    app.innerHTML = shell(`
      ${brand}
      <div><div class="eyebrow">${esc(B.event)}</div></div>
      <h1>${esc(B.round)}</h1>
      <p class="sub">${esc(B.details)}</p>
      <form id="joinForm" class="field" autocomplete="off" novalidate>
        <label for="code">Contest code</label>
        <input id="code" class="codein" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="KIO-XXXX-XXXX" value="${esc(prettyCode(prefill))}" maxlength="13" aria-describedby="joinErr">
        <p class="err" id="joinErr" role="alert">${esc(err)}</p>
        <button class="btn primary" id="joinBtn" type="submit">Enter the contest room</button>
      </form>
      <p class="fine">Use the code sent to you. If your page reloads or your connection drops, enter the same code on the same device to carry on where you left off.</p>`);
    const inp = document.getElementById('code');
    inp.addEventListener('input', () => { const p = inp.selectionStart === inp.value.length; inp.value = prettyCode(inp.value); if (p) inp.selectionStart = inp.selectionEnd = inp.value.length; });
    document.getElementById('joinForm').addEventListener('submit', e => { e.preventDefault(); join(inp.value); });
    if (!prefill) inp.focus();
  }

  async function join(code, quiet) {
    code = normCode(code);
    const btn = document.getElementById('joinBtn');
    const errEl = document.getElementById('joinErr');
    if (code.length < 6) { if (errEl) errEl.textContent = 'Enter the contest code you were sent.'; return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    const saved = store.get('cr:' + code) || {};
    const t0 = Date.now();
    let r;
    try { r = await api('join', { code, token: saved.token || null }); }
    catch (e) {
      if (quiet) return screenJoin(code, '');
      if (btn) { btn.disabled = false; btn.textContent = 'Enter the contest room'; }
      if (errEl) errEl.textContent = e.message;
      return;
    }
    setClock(r.serverNow, t0, Date.now());
    Object.assign(S, { code, student: r.student, start: r.start, end: r.end, syncSeconds: r.syncSeconds || 60, fallbackEmail: r.fallbackEmail || '', mode: r.mode });
    store.set('cr:last', code);
    if (r.status === 'waiting') return screenWaiting();
    if (r.status === 'submitted') { S.submitted = true; return screenDone('submitted', r.submittedAt); }
    if (r.status === 'closed') return screenDone('closed');
    if (r.status === 'join_closed') return screenDone('join_closed');
    if (r.status === 'open') return openExam(r, saved);
  }

  function whoCard() {
    const s = S.student || {};
    return `<dl class="who-card">
      <dt>Name</dt><dd>${esc(s.name || '—')}</dd>
      ${s.school ? `<dt>School</dt><dd>${esc(s.school)}</dd>` : ''}
      ${s.candidateNo ? `<dt>Candidate</dt><dd>${esc(s.candidateNo)}</dd>` : ''}
      <dt>Code</dt><dd style="font-family:var(--mono)">${esc(prettyCode(S.code))}</dd></dl>`;
  }

  function screenWaiting() {
    app.dataset.screen = 'waiting';
    app.innerHTML = shell(`
      ${brand}
      <div><div class="eyebrow">Waiting room</div></div>
      <h1>The paper opens at ${esc(eat(S.start))}</h1>
      <p class="sub">${esc(eatDate(S.start))}</p>
      ${whoCard()}
      <div class="field"><span class="eyebrow">Opens in</span><div class="count" id="count">--:--:--</div></div>
      <ul class="rules">
        <li>Keep this page open. The paper appears here automatically at the start time.</li>
        <li>You have 2 hours 30 minutes. The clock is the same for everyone and does not pause.</li>
        <li>Answers save as you work. Stay on this page: leaving it, switching tabs and pasting text are recorded.</li>
        <li>Use one device only. Opening your code somewhere else locks this window.</li>
      </ul>
      <div class="row"><button class="btn" id="fsBtn" type="button">Switch to full screen</button><span class="fine">Recommended during the contest.</span></div>`, true);
    document.getElementById('fsBtn').addEventListener('click', enterFullscreen);
    const el = document.getElementById('count');
    el.textContent = hms(S.start - now());
    let opening = false;
    const t = setInterval(async () => {
      const left = S.start - now();
      el.textContent = hms(left);
      if (left <= 0 && !opening) {
        opening = true; clearInterval(t);
        el.textContent = 'Opening…';
        await sleep(500 + Math.random() * 12000); // stagger 4000 students over ~12 s
        for (let i = 0; i < 20 && app.dataset.screen === 'waiting'; i++) {
          await join(S.code, true).catch(() => { });
          if (app.dataset.screen === 'waiting') await sleep(3000 + Math.random() * 4000);
        }
      }
    }, 250);
  }

  function screenDone(kind, at) {
    stopExam();
    app.dataset.screen = kind;
    const n = S.paper ? countAnswered() : null;
    const msg = {
      submitted: ['Your answers are in', `Submitted${at ? ' at ' + eat(at) : ''}. You can close this page.${n != null ? ` You answered ${n} of 20 problems.` : ''}`, ''],
      closed: ['The contest has ended', S.lastSaved ? `Your answers were saved automatically, last at ${eat(S.lastSaved)}. You can close this page.` : 'This contest is closed. Answers saved during the contest have been kept.', 'warn'],
      join_closed: ['Entry has closed', 'The time for joining this contest has passed. Speak to your contest coordinator.', 'warn'],
      superseded: ['This code is open on another device', 'This window has stopped saving. Only the most recent device can answer. If this was not you, tell your contest coordinator now.', 'warn'],
    }[kind];
    app.innerHTML = shell(`${brand}<div class="done-mark ${msg[2]}">${msg[2] ? '!' : '✓'}</div><h1>${esc(msg[0])}</h1><p class="sub" style="margin:0">${esc(msg[1])}</p>${whoCard()}`);
    if (exitFs && document.fullscreenElement) document.exitFullscreen?.().catch(() => { });
  }
  const onSubmitted = () => { S.submitted = true; persist(); hideOverlay(); screenDone('submitted', now()); };
  const onClosed = () => { S.locked = true; persist(); hideOverlay(); screenDone('closed'); };
  const onSuperseded = () => { S.superseded = true; hideOverlay(); screenDone('superseded'); };

  // ---------- exam ----------
  function openExam(r, saved) {
    S.token = r.token; S.paper = r.paper;
    S.answers = { ...(r.answers || {}) };
    const sameSession = saved.token && saved.token === r.token;
    // Restore work from this device that the server may not have yet.
    const localDirty = new Set(saved.dirty || []);
    if (saved.pending?.ans) for (const k of Object.keys(saved.pending.ans)) localDirty.add(k);
    for (const k of localDirty) if (saved.answers && k in saved.answers) { S.answers[k] = saved.answers[k]; S.dirty.add(k); }
    S.flags = new Set(saved.flags || []);
    S.cur = saved.cur || 'intro';
    if (sameSession) {
      S.events = saved.events || []; S.seq = saved.seq || 0; S.pending = saved.pending || null; S.syncN = saved.syncN || 0;
      S.finalRequested = !!saved.finalRequested;
    } else { S.events = []; S.seq = 0; S.pending = null; S.syncN = 0; }
    const reloads = (store.get('cr:loads:' + S.code) || 0) + 1;
    store.set('cr:loads:' + S.code, reloads);
    persist();
    renderExam();
    log('ld', '', r.kind || '', reloads);
    startSyncLoop();
    bindGlobal();
    if (S.finalRequested) requestFinal();
    if (now() >= S.end) timeUp();
  }

  let tickT;
  function stopExam() { clearInterval(tickT); clearTimeout(syncTimer); unbindGlobal(); }

  function renderExam() {
    app.dataset.screen = 'exam';
    const s = S.student || {};
    app.innerHTML = `
      <div class="exam">
        <div><div class="flagline"></div>${ribbon(true)}
        <header class="bar">
          <div class="bar-l">${logos('small')}${brand}<div class="who"><b>${esc(s.name || '')}</b>${s.school ? ' · ' + esc(s.school) : ''} · <span style="font-family:var(--mono)">${esc(prettyCode(S.code))}</span></div></div>
          <div class="bar-r"><span class="save" id="save" aria-live="polite">Saved</span><div class="timer" id="timer" aria-label="Time remaining">--:--:--</div><button class="btn primary" id="submitBtn" type="button">Submit</button></div>
        </header></div>
        <div class="banner" id="banner" hidden></div>
        <div class="banner" id="ebanner" hidden><span>We can't reach the server. Your answers are safe on this device and will send when the connection returns.</span><button class="btn" type="button" data-savefile>Save a copy of my answers</button></div>
        <div class="layout">
          <nav class="nav" id="nav" aria-label="Problems"></nav>
          <main class="main" id="main"><div class="qwrap" id="q"></div></main>
        </div>
      </div>`;
    document.getElementById('submitBtn').addEventListener('click', askSubmit);
    const q = document.getElementById('q');
    q.addEventListener('input', onInput);
    q.addEventListener('keydown', onKey);
    q.addEventListener('paste', onPaste);
    q.addEventListener('change', onChange);
    q.addEventListener('click', onClickQ);
    document.getElementById('nav').addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
    renderNav(); renderQ();
    tick(); tickT = setInterval(tick, 250);
    if (SHOWLOG) demoPanel();
  }

  const problems = () => S.paper.sections.flatMap(sec => sec.problems.map(p => ({ ...p, sec })));
  const isAnswered = p => p.type === 'written' ? p.parts.some(pt => (S.answers[p.id + pt.id] || '').trim()) : !!(S.answers[p.id] || '').trim();
  const countAnswered = () => problems().filter(isAnswered).length;

  function renderNav() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const all = problems(); const done = all.filter(isAnswered).length;
    nav.innerHTML = `<button class="nav-intro ${S.cur === 'intro' ? 'cur' : ''}" data-go="intro" type="button">Instructions</button>` +
      S.paper.sections.map(sec => `<div class="nav-sec"><div class="nav-h"><span>${sec.id}</span><span class="nt">&nbsp;· ${esc(sec.title)}</span></div><div class="grid">${sec.problems.map(p =>
        `<button type="button" data-go="${p.id}" class="qb ${isAnswered(p) ? 'done' : ''} ${S.cur === p.id ? 'cur' : ''} ${S.flags.has(p.id) ? 'flag' : ''}" aria-label="Problem ${p.id}${isAnswered(p) ? ', answered' : ''}${S.flags.has(p.id) ? ', marked to come back to later' : ''}">${p.id}</button>`).join('')}</div></div>`).join('') +
      `<div class="progress"><span>${done} of ${all.length} answered</span><div class="pbar"><i style="width:${(done / all.length) * 100}%"></i></div>
        <div class="legend"><span><i style="background:var(--accent);border-color:var(--accent)"></i>Answered</span><span><i style="background:var(--flag);border-color:var(--flag);border-radius:50%"></i>Come back later</span></div></div>`;
  }

  function moneyRef() {
    const m = S.paper.money;
    if (!m) return '';
    return `<details class="ref"><summary>${esc(m.title)}</summary><div class="tw"><table>${m.rows.map(r => `<tr>${r.map(c => `<td>${rich(c)}</td>`).join('')}</tr>`).join('')}</table><p class="fine" style="margin:.5rem 0 0">${rich(m.note)}</p></div></details>`;
  }

  function renderQ() {
    const q = document.getElementById('q');
    const dis = S.locked ? 'disabled' : '';
    if (S.cur === 'intro') {
      q.innerHTML = `<div class="q-meta"><span>${esc(S.paper.title)} · ${esc(S.paper.round)}</span></div><h2>Instructions</h2>
        <ol class="rules q-text" style="font-size:1rem">${S.paper.instructions.map(t => `<li>${t}</li>`).join('')}</ol>${moneyRef()}
        <div class="q-foot"><span></span><button class="btn primary" type="button" data-nav="next">Start: Problem 1 →</button></div>`;
      return;
    }
    const all = problems(); const idx = all.findIndex(p => p.id === S.cur); const p = all[idx];
    let body = '';
    if (p.type === 'mcq') {
      // p.perm (if present) is this student's option order: display position d shows original option p.perm[d].
      // The stored answer is always the original letter, so marking is unaffected by the shuffle.
      const order = p.perm || p.options.map((_, i) => i);
      body = `<div class="opts ${S.locked ? 'locked' : ''}" role="radiogroup" aria-label="Options">${order.map((orig, d) => { const shown = 'ABCDE'[d], L = 'ABCDE'[orig]; return `
        <label class="opt"><input type="radio" name="mcq" value="${L}" data-shown="${shown}" ${S.answers[p.id] === L ? 'checked' : ''} ${dis}><span class="letter">${shown}</span><span>${rich(p.options[orig])}</span></label>`; }).join('')}</div>
        ${S.answers[p.id] && !S.locked ? '<div><button class="linkbtn" type="button" data-clear="1">Clear my choice</button></div>' : ''}`;
    } else if (p.type === 'written') {
      body = p.parts.map(pt => { const k = p.id + pt.id; return `<div class="part"><div class="part-h noselect"><span class="pl">(${pt.id})</span><span>${rich(pt.text)}</span><span class="pm">${pt.marks} mark${pt.marks > 1 ? 's' : ''}</span></div>
        <textarea class="ans" id="a-${k}" data-k="${k}" spellcheck="false" autocomplete="off" aria-label="Answer to part (${pt.id})" placeholder="Your answer and working" ${dis}>${esc(S.answers[k] || '')}</textarea></div>`; }).join('');
    } else {
      body = `${p.constraints ? `<div class="box"><span class="lbl">Constraints</span>${rich(p.constraints)}</div>` : ''}
        ${p.example ? `<div class="box ex"><span class="lbl">Example</span>${rich(p.example)}</div>` : ''}
        <p class="task noselect"><b>Your task.</b> Describe an efficient algorithm. Explain the key idea, justify why it is correct, and state its time complexity. You do not need to write code.</p>
        <textarea class="ans big" id="a-${p.id}" data-k="${p.id}" spellcheck="false" autocomplete="off" aria-label="Your algorithm" placeholder="Key idea&#10;&#10;Steps of the algorithm&#10;&#10;Why it is correct&#10;&#10;Time complexity" ${dis}>${esc(S.answers[p.id] || '')}</textarea>
        <div class="ans-meta"><span id="wc"></span></div>`;
    }
    q.innerHTML = `
      <div class="q-meta"><span>Section ${p.sec.id} · ${esc(p.sec.title)}</span><span>Problem ${idx + 1} of ${all.length} · ${p.marks} marks</span></div>
      <h2>Problem ${p.id}</h2>
      ${p.sec.money ? moneyRef() : ''}
      ${p.sec.intro && p.id === p.sec.problems[0].id ? `<p class="task noselect" style="margin:0">${p.sec.intro}</p>` : ''}
      ${p.text ? `<div class="q-text">${rich(p.text)}</div>` : ''}
      ${body}
      <div class="q-foot">
        <button class="btn" type="button" data-nav="prev">← Previous</button>
        <button class="btn ${S.flags.has(p.id) ? 'flagged' : ''}" type="button" data-flag="${p.id}" title="Puts an orange dot on this problem's number so you can find it again. It does not affect your marks.">${S.flags.has(p.id) ? '● Marked to come back later (click to remove)' : 'Come back to this later'}</button>
        ${idx < all.length - 1 ? `<button class="btn primary" type="button" data-nav="next">Next →</button>` : `<button class="btn primary" type="button" data-nav="submit">Review and submit</button>`}
      </div>`;
    updateWc();
    q.querySelectorAll('textarea.ans').forEach(autosize);
  }

  function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 1400) + 'px'; }
  function updateWc() { const w = document.getElementById('wc'); const t = document.querySelector('textarea.ans.big'); if (w && t) { const n = (t.value.trim().match(/\S+/g) || []).length; w.textContent = `${n} word${n === 1 ? '' : 's'}`; } }

  function go(id) {
    if (id === S.cur) return;
    S.cur = id; log('go', id); persistSoon();
    renderNav(); renderQ();
    document.getElementById('main').scrollTop = 0;
  }

  function onClickQ(e) {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const ids = ['intro', ...problems().map(p => p.id)];
      const i = ids.indexOf(S.cur);
      if (nav.dataset.nav === 'next') go(ids[i + 1]);
      else if (nav.dataset.nav === 'prev') go(ids[i - 1]);
      else askSubmit();
      return;
    }
    const fl = e.target.closest('[data-flag]');
    if (fl) { const id = fl.dataset.flag; S.flags.has(id) ? S.flags.delete(id) : S.flags.add(id); log('fl', id, S.flags.has(id) ? 1 : 0); persistSoon(); renderNav(); renderQ(); return; }
    if (e.target.closest('[data-clear]') && !S.locked) { S.answers[S.cur] = ''; S.dirty.add(S.cur); log('mc', S.cur, 'clear'); persistSoon(); renderNav(); renderQ(); }
  }

  function onChange(e) {
    if (e.target.name === 'mcq' && !S.locked) {
      S.answers[S.cur] = e.target.value; S.dirty.add(S.cur); log('mc', S.cur, e.target.value, e.target.dataset.shown || '');
      persistSoon(); setSave('pending'); renderNav(); renderQ();
    }
  }

  const lastLen = new Map();
  function onInput(e) {
    const t = e.target; const k = t.dataset?.k;
    if (!k || S.locked) return;
    const prev = lastLen.has(k) ? lastLen.get(k) : (S.answers[k] || '').length;
    const delta = t.value.length - prev;
    lastLen.set(k, t.value.length);
    S.answers[k] = t.value; S.dirty.add(k);
    if (delta >= 15 && e.inputType !== 'insertFromPaste') log('in', k, delta, e.inputType || ''); // large insert without paste: autofill, dictation, or injected text
    autosize(t); updateWc(); setSave('pending'); persistSoon();
    const p = problems().find(p => p.id === S.cur);
    const nb = document.querySelector(`.qb[data-go="${S.cur}"]`);
    if (p && nb && nb.classList.contains('done') !== isAnswered(p)) renderNav();
  }

  function keyCat(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    if (e.key.length === 1) return 'c';
    return { Backspace: 'b', Delete: 'd', Enter: 'e', Tab: 't', ArrowLeft: 'a', ArrowRight: 'a', ArrowUp: 'a', ArrowDown: 'a', Home: 'a', End: 'a', PageUp: 'a', PageDown: 'a' }[e.key] || null;
  }
  const combo = e => [e.ctrlKey && 'ctrl', e.metaKey && 'meta', e.altKey && 'alt', e.shiftKey && 'shift', e.key.length === 1 ? e.key.toLowerCase() : e.key].filter(Boolean).join('+');
  function onKey(e) {
    const k = e.target.dataset?.k; if (!k) return;
    const c = keyCat(e);
    if (c) log('k', k, c, e.target.value.length);
    else if (e.ctrlKey || e.metaKey || e.altKey) { if (!['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) log('kb', k, combo(e)); }
  }

  const normClip = s => String(s || '').replace(/\s+/g, ' ').trim();
  function onPaste(e) {
    const k = e.target.dataset?.k; if (!k) return;
    const text = e.clipboardData?.getData('text') || '';
    if (S.internalClip && normClip(text) && normClip(S.internalClip).includes(normClip(text))) { log('p', k, text.length); return; }
    e.preventDefault(); log('pb', k, text.length);
    toast('Pasting text from outside the contest is turned off. You can still move text between your own answers.');
  }

  // ---------- global listeners ----------
  const G = {
    blur: () => log('bl', S.cur),
    focus: () => log('fo', S.cur),
    vis: () => {
      if (document.hidden) { log('hid', S.cur); if (Date.now() - S.lastHideFlush > 30000) { S.lastHideFlush = Date.now(); sync(); } }
      else log('vis', S.cur);
    },
    fs: () => { if (document.fullscreenElement) { log('fse'); showBanner(null); } else { log('fsx'); if (!S.locked) showBanner('You left full screen. This is recorded.', 'Return to full screen', enterFullscreen); } },
    copy: e => {
      const t = e.target;
      if (t?.dataset?.k) { S.internalClip = t.value.substring(t.selectionStart, t.selectionEnd); log('cp', t.dataset.k, S.internalClip.length, e.type); }
      else { const sel = String(window.getSelection?.() || ''); e.preventDefault(); log('cp', S.cur, sel.length, e.type + '-q'); }
    },
    ctx: () => log('ctx', S.cur),
    key: e => {
      if (e.target?.dataset?.k) return;
      if (e.ctrlKey || e.metaKey || e.key === 'F12' || e.key === 'PrintScreen') { if (!['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) log('kb', S.cur, combo(e)); }
      if ((e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key.toLowerCase())) e.preventDefault();
    },
    resize: (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => log('rz', S.cur, innerWidth, innerHeight), 800); }; })(),
    online: () => { log('on'); sync(); },
    offline: () => { log('off'); setSave('offline'); },
    print: () => log('kb', S.cur, 'print'),
    hide: () => flushOnLeave(),
  };
  let bound = false;
  function bindGlobal() {
    if (bound) return; bound = true;
    addEventListener('blur', G.blur); addEventListener('focus', G.focus);
    document.addEventListener('visibilitychange', G.vis);
    document.addEventListener('fullscreenchange', G.fs);
    document.addEventListener('copy', G.copy); document.addEventListener('cut', G.copy);
    document.addEventListener('contextmenu', G.ctx);
    document.addEventListener('keydown', G.key, true);
    addEventListener('resize', G.resize);
    addEventListener('online', G.online); addEventListener('offline', G.offline);
    addEventListener('beforeprint', G.print);
    addEventListener('pagehide', G.hide);
  }
  function unbindGlobal() {
    if (!bound) return; bound = false;
    removeEventListener('blur', G.blur); removeEventListener('focus', G.focus);
    document.removeEventListener('visibilitychange', G.vis);
    document.removeEventListener('fullscreenchange', G.fs);
    document.removeEventListener('copy', G.copy); document.removeEventListener('cut', G.copy);
    document.removeEventListener('contextmenu', G.ctx);
    document.removeEventListener('keydown', G.key, true);
    removeEventListener('resize', G.resize);
    removeEventListener('online', G.online); removeEventListener('offline', G.offline);
    removeEventListener('beforeprint', G.print);
    removeEventListener('pagehide', G.hide);
  }

  const exitFs = true;
  function enterFullscreen() { document.documentElement.requestFullscreen?.().catch(() => toast('Full screen is not available in this browser.')); }

  function showBanner(text, action, fn) {
    const b = document.getElementById('banner'); if (!b) return;
    if (!text) { b.hidden = true; return; }
    b.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="btn" type="button" id="bannerBtn">${esc(action)}</button>` : ''}`;
    b.hidden = false;
    if (fn) document.getElementById('bannerBtn').onclick = fn;
  }

  function setSave(state) {
    const el = document.getElementById('save'); if (!el) return;
    el.className = 'save ' + (state === 'saved' ? '' : state === 'offline' ? 'offline' : 'saving');
    el.textContent = state === 'saved' ? (S.lastSaved ? 'Saved ' + eat(S.lastSaved).replace(' EAT', '') : 'Saved')
      : state === 'saving' ? 'Saving…' : state === 'offline' ? 'Offline · kept on this device' : 'Saved on this device';
  }

  function tick() {
    const el = document.getElementById('timer'); if (!el) return;
    const left = S.end - now();
    el.textContent = hms(left);
    el.className = 'timer' + (left <= 60_000 ? ' crit' : left <= 10 * 60_000 ? ' warn' : '');
    for (const m of [30, 10, 5, 1]) if (left <= m * 60_000 && left > (m * 60_000 - 5000) && !S.warned.has(m)) { S.warned.add(m); toast(`${m} minute${m > 1 ? 's' : ''} left.`); }
    if (left <= 0 && !S.locked) timeUp();
  }

  function timeUp() {
    if (S.locked) return;
    S.locked = true; log('sub', '', 'time'); renderQ();
    showOverlay('Time is up', 'Submitting your answers. Keep this page open.');
    requestFinal();
  }

  function askSubmit() {
    if (S.locked) return;
    const missing = problems().filter(p => !isAnswered(p)).map(p => p.id);
    const flagged = [...S.flags];
    const sc = document.createElement('div');
    sc.className = 'scrim';
    sc.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
      <h3 id="mh">Submit your answers?</h3>
      <p>You have answered <b>${problems().length - missing.length} of ${problems().length}</b> problems.${missing.length ? ` Not answered: ${missing.join(', ')}.` : ''}${flagged.length ? ` You marked to come back to: ${flagged.join(', ')}.` : ''}</p>
      <p class="fine">After you submit you cannot change anything. You still have ${hms(S.end - now())}.</p>
      <div class="row"><button class="btn" type="button" id="mNo">Keep working</button><button class="btn primary" type="button" id="mYes">Submit answers</button></div></div>`;
    document.body.appendChild(sc);
    document.getElementById('mNo').focus();
    document.getElementById('mNo').onclick = () => sc.remove();
    document.getElementById('mYes').onclick = () => { sc.remove(); S.locked = true; log('sub', '', 'manual'); renderQ(); showOverlay('Submitting', 'Sending your answers. Keep this page open.'); requestFinal(); };
  }

  function showOverlay(title, text, retry) {
    hideOverlay();
    const sc = document.createElement('div');
    sc.className = 'scrim'; sc.id = 'overlay';
    sc.innerHTML = `<div class="modal" role="alertdialog" aria-live="assertive"><h3>${esc(title)}</h3><p>${esc(text)}</p>${retry ? `<p class="fine">If this continues, save a copy of your answers${S.fallbackEmail ? ` and email the file to <b>${esc(S.fallbackEmail)}</b>` : ' and send it to your contest coordinator'}.</p><div class="row"><button class="btn" type="button" data-savefile>Save a copy of my answers</button><button class="btn primary" type="button" id="retryBtn">Try again now</button></div>` : ''}</div>`;
    document.body.appendChild(sc);
    if (retry) document.getElementById('retryBtn').onclick = () => { showOverlay('Submitting', 'Sending your answers.'); requestFinal(); };
  }
  function hideOverlay() { document.getElementById('overlay')?.remove(); }

  // ---------- emergency copy: a text file of the student's answers ----------
  function saveFile() {
    if (!S.paper) return;
    const s = S.student || {};
    const lines = [`${S.paper.title} · ${S.paper.round}`, `Name: ${s.name || ''}`, `School: ${s.school || ''}`, `Code: ${prettyCode(S.code)}`,
      `Saved: ${new Date(now()).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' })} EAT`, `Last saved to server: ${S.lastSaved ? eat(S.lastSaved) : 'never'}`, ''];
    for (const p of problems()) {
      lines.push(`==== Problem ${p.id} ====`);
      if (p.type === 'written') for (const pt of p.parts) lines.push(`(${pt.id}) ${S.answers[p.id + pt.id] || ''}`);
      else if (p.type === 'mcq') { const L = S.answers[p.id]; const i = 'ABCDE'.indexOf(L || '?'); lines.push(i >= 0 ? `Chosen option: ${p.options[i].replace(/<[^>]+>|\$/g, '')} [${L}]` : ''); }
      else lines.push(S.answers[p.id] || '');
      lines.push('');
    }
    lines.push('---- machine-readable copy (do not edit) ----', JSON.stringify({ code: S.code, at: now(), answers: S.answers }));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${prettyCode(S.code)}-answers.txt` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    log('exp', S.cur);
    toast(S.fallbackEmail ? `Saved. If the site stays down, email this file to ${S.fallbackEmail}.` : 'Saved. If the site stays down, send this file to your contest coordinator.', 8000);
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-savefile]')) saveFile(); });

  // ---------- demo-only activity panel ----------
  const EV_NAMES = { k: 'key', in: 'large insert', p: 'paste (own text)', pb: 'paste blocked', cp: 'copy', bl: 'window lost focus', fo: 'window focused', hid: 'tab hidden', vis: 'tab visible', fsx: 'left full screen', fse: 'full screen', go: 'opened problem', mc: 'chose option', fl: 'come back later', ctx: 'right-click', kb: 'shortcut', rz: 'resized', on: 'online', off: 'offline', ld: 'page loaded', sub: 'submit', exp: 'saved answers to file' };
  function demoPanel() {
    if (document.getElementById('demoLog')) return;
    const d = document.createElement('aside');
    d.className = 'demo-log'; d.id = 'demoLog';
    d.innerHTML = '<header><span>Activity log (what the server receives)</span><button class="btn ghost" type="button" id="dlx" style="padding:.1rem .4rem">Hide</button></header><ol id="dlo"></ol>';
    document.body.appendChild(d);
    document.getElementById('dlx').onclick = () => { const o = document.getElementById('dlo'); o.hidden = !o.hidden; document.getElementById('dlx').textContent = o.hidden ? 'Show' : 'Hide'; };
  }
  function demoLog(e) {
    const o = document.getElementById('dlo'); if (!o) return;
    const li = document.createElement('li');
    const t = e[0] / 1000;
    li.innerHTML = `<span>${t < 0 ? '-' : ''}${Math.floor(Math.abs(t) / 60)}:${pad(Math.floor(Math.abs(t)) % 60)}</span><span>${esc(EV_NAMES[e[1]] || e[1])}${e[2] ? ' · ' + esc(e[2]) : ''}${e[3] !== '' ? ' · ' + esc(e[3]) : ''}</span>`;
    o.prepend(li);
    while (o.children.length > 150) o.lastChild.remove();
  }

  // ---------- boot ----------
  // Logos and event text set on the admin page override public/branding.js. Never blocks for long.
  async function loadBrand() {
    if (DEMO || window.CR_API) return;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch('/api/brand', { signal: ctl.signal }); clearTimeout(t);
      const j = await r.json();
      for (const k of ['event', 'round', 'details']) if (j.brand?.[k]) B[k] = j.brand[k];
      if (j.logos?.length) B.logos = j.logos.map(l => ({ src: '/api/brand?logo=' + encodeURIComponent(l.id), alt: l.alt }));
    } catch { /* keep defaults */ }
  }
  await loadBrand();
  if (PREVIEW) {
    // Admin preview: loads the paper with the admin key from /admin; nothing is saved.
    let key = decodeURIComponent((location.hash.match(/k=([^&]+)/) || [])[1] || '');
    if (key) history.replaceState(null, '', location.pathname + location.search); // remove the key from the address bar
    if (!key) try { key = sessionStorage.getItem('crk') || ''; } catch { }
    window.CR_API = async (path, b) => {
      if (path === 'join') {
        const r = await fetch('/api/admin?action=paper', { headers: { 'x-admin-key': key } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error === 'Wrong admin key' ? 'Open the preview from the admin page after unlocking it.' : (j.error || 'Could not load the paper.'));
        const now = Date.now();
        return { serverNow: now, start: now - 1000, end: now + (j.minutes || 150) * 60000, syncSeconds: 3600, status: 'open', token: 'preview', kind: 'new',
          student: { name: 'Preview', school: 'Admin', code: 'KIOPREVIEWXX' }, paper: j.paper, answers: {} };
      }
      return { ok: true, serverNow: Date.now() };
    };
    try { Object.keys(localStorage).filter(k => k.includes('KIOPREVIEW')).forEach(k => localStorage.removeItem(k)); } catch { }
    screenJoin('KIOPREVIEWXX'); join('KIOPREVIEWXX');
    return;
  }
  const last = store.get('cr:last');
  const lastState = last ? store.get('cr:' + last) : null;
  if (last && lastState?.token) { screenJoin(last); join(last, true); }
  else screenJoin(last || '');
})();
