// Converts the LaTeX problem paper into the online paper.
//
//   npm run paper                       (reads paper/round1.tex)
//   node scripts/tex-to-paper.js paper/other.tex
//
// Writes lib/paper.js (the paper students see) and lib/key.js (Section A answers, read from the
// marking-scheme table inside \ifanswers ... \fi). Vercel runs this on every deploy, so editing the
// .tex file on GitHub and pushing is enough to update the live paper.
//
// Understands the KIO template: \section*{Section X \quad Title \hfill\normalsize (notes)},
// \begin{problem}{marks}, \mcq{A}{B}{C}{D}{E}, mcqlong, parts (\item ... \hfill [n]), \answerline,
// \textbf{Constraints.}, example, \task, enumerate, \textbf/\emph/\texttt, inline maths $...$.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const file = process.argv[2] || 'paper/round1.tex';
const raw = readFileSync(file, 'utf8');
const warnings = new Set();

// ---------- helpers ----------
const stripComments = t => t.replace(/(^|[^\\])%.*$/gm, '$1');

function readGroup(s, i) { // s[i] === '{' → [content, indexAfter]
  while (s[i] === ' ' || s[i] === '\n') i++;
  if (s[i] !== '{') return [null, i];
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return [s.slice(i + 1, j), j + 1];
  }
  throw new Error('Unbalanced braces near: ' + s.slice(i, i + 60));
}

// answers=true keeps the marking-scheme branch; false keeps the print branch; 'none' drops both (online paper)
function resolveIfs(s, answers = false) {
  for (;;) {
    const i = s.search(/\\ifanswers(?![a-zA-Z])/);
    if (i < 0) return s;
    const re = /\\(ifanswers|else|fi)(?![a-zA-Z])/g;
    re.lastIndex = i + 10;
    let depth = 0, elsePos = -1, m;
    while ((m = re.exec(s))) {
      if (m[1] === 'ifanswers') depth++;
      else if (m[1] === 'else' && depth === 0) elsePos = m.index;
      else if (m[1] === 'fi') { if (depth === 0) break; depth--; }
    }
    if (!m) throw new Error('\\ifanswers without \\fi');
    const yes = s.slice(i + 10, elsePos >= 0 ? elsePos : m.index);
    const no = elsePos >= 0 ? s.slice(elsePos + 5, m.index) : '';
    s = s.slice(0, i) + (answers === 'none' ? '' : answers ? yes : no) + s.slice(m.index + 3);
  }
}

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function envItems(body) {
  return body.replace(/^\s*\[[^\]]*\]/, '').split(/\\item(?![a-zA-Z])/).slice(1).map(x => x.trim());
}

// LaTeX text → HTML, leaving $...$ maths for the browser's renderer.
function html(src, { paragraphs = true } = {}) {
  let s = src.replace(/\\\$/g, '\u0001');
  const maths = [];
  s = s.replace(/\$([^$]*)\$/g, (_, m) => { maths.push(m); return `\u0002${maths.length - 1}\u0003`; });
  s = esc(s);
  // print-only layout: tables, centred blocks, macro redefinitions
  s = s.replace(/\\begin\{(center|tabular\*?)\}[\s\S]*?\\end\{\1\}/g, ' ')
    .replace(/\\(renewcommand|newcommand|setlength)\s*\{?\\[a-zA-Z]+\}?\{[^}]*\}/g, ' ');

  // lists
  s = s.replace(/\\begin\{(enumerate|itemize)\}([\s\S]*?)\\end\{\1\}/g, (_, kind, body) =>
    `\n\u0004${kind === 'enumerate' ? 'ol' : 'ul'}>${envItems(body).map(x => `<li>${x}</li>`).join('')}</${kind === 'enumerate' ? 'ol' : 'ul'}>\n`);

  // one-argument commands (repeat for nesting)
  const ONE = { textbf: ['<b>', '</b>'], emph: ['<em>', '</em>'], textit: ['<em>', '</em>'], texttt: ['<code>', '</code>'],
    textsc: ['', ''], underline: ['<u>', '</u>'], mbox: ['', ''], text: ['', ''] };
  for (let guard = 0; guard < 50; guard++) {
    const m = /\\(textbf|emph|textit|texttt|textsc|underline|mbox|text)\s*\{/.exec(s);
    if (!m) break;
    const [inner, end] = readGroup(s, m.index + m[0].length - 1);
    s = s.slice(0, m.index) + ONE[m[1]][0] + inner + ONE[m[1]][1] + s.slice(end);
  }
  s = s.replace(/\\vspace\*?\{[^}]*\}/g, '')
    .replace(/\\(smallskip|medskip|bigskip|noindent|clearpage|newpage|nopagebreak|hfill|centering|answerline)(?![a-zA-Z])\s*/g, ' ')
    .replace(/\\par(?![a-zA-Z])/g, '\n\n')
    .replace(/\\pounds(?![a-zA-Z])\s?/g, '£')
    .replace(/\\(dots|ldots)(?![a-zA-Z])/g, '…')
    .replace(/\\tfrac\s*1\s*2|\\tfrac\{1\}\{2\}/g, '½')
    .replace(/\\quad(?![a-zA-Z])/g, ' &nbsp; ')
    .replace(/\\[,;: \n]/g, ' ')
    .replace(/\\\\(\[[^\]]*\])?/g, '<br>')
    .replace(/\\%/g, '%').replace(/\\&amp;/g, '&amp;').replace(/\\_/g, '_').replace(/\\#/g, '#')
    .replace(/~/g, '&nbsp;')
    .replace(/---/g, '—').replace(/--/g, '–')
    .replace(/``/g, '“').replace(/''/g, '”').replace(/`/g, '‘').replace(/'/g, '’');
  s = s.replace(/\\([a-zA-Z]+)/g, (_, c) => { warnings.add('\\' + c); return ''; });
  s = s.replace(/[{}]/g, '');

  // paragraphs: first one bare, later ones in <p>; lists stand on their own
  const paras = s.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let out = '';
  let first = true;
  for (const p of paras) {
    for (const part of p.split(/(\u0004[ou]l>[\s\S]*?<\/[ou]l>)/)) {
      const t = part.trim(); if (!t) continue;
      if (t.startsWith('\u0004')) out += '<' + t.slice(1);
      else if (first || !paragraphs) out += (out ? ' ' : '') + t;
      else out += `<p>${t}</p>`;
      first = false;
    }
  }
  if (!paragraphs) out = out.replace(/\s+/g, ' ');
  return out
    .replace(/\u0002(\d+)\u0003/g, (_, i) => '$' + maths[i].replace(/\\[;:]/g, '\\,').replace(/\\quad/g, '\\,\\,').replace(/\s+/g, ' ').trim() + '$')
    .replace(/\u0001/g, '&#36;');
}

// ---------- read the document ----------
const all = stripComments(raw);
const docStart = all.indexOf('\\begin{document}');
const docEnd = all.lastIndexOf('\\end{document}');
const docAll = all.slice(docStart + 16, docEnd < 0 ? undefined : docEnd);

// Section A key from the marking-scheme table
const withAnswers = resolveIfs(docAll, true);
const key = {};
for (const m of withAnswers.matchAll(/\\textbf\{Problem\}([^\n]*?)\\\\[\s\S]*?\\textbf\{Answer\}([^\n]*?)\\\\/g)) {
  const nums = m[1].split('&').map(x => x.trim()).filter(Boolean);
  const ls = m[2].split('&').slice(1).map(x => x.trim());
  if (ls.some(x => /^[A-E]$/.test(x))) nums.forEach((n, i) => { if (/^[A-E]$/.test(ls[i] || '')) key[n] = ls[i]; });
}

const doc = resolveIfs(docAll, 'none');

const title = (doc.match(/\\LARGE\\bfseries\s*([^}]*)\}/) || [])[1]?.trim() || 'Kenya Informatics Olympiad';
const round = ((doc.match(/\\Large\s*([^}]*)\}/) || [])[1] || 'Round 1').split(/---|—/)[0].trim();

// Money / reference box
let money = null;
const box = /\\begin\{tcolorbox\}(\[[\s\S]*?\])?([\s\S]*?)\\end\{tcolorbox\}/.exec(doc);
if (box) {
  const t = (/title=\\textbf\{([^}]*)\}/.exec(box[1] || '') || [])[1] || 'Reference';
  const tab = /\\begin\{tabular\}\{[^\n]*\n([\s\S]*?)\\end\{tabular\}/.exec(box[2]);
  const rows = tab ? tab[1].split('\n').filter(l => l.includes('&')).map(l => l.replace(/\\\\.*$/, '').split('&').map(c => html(c, { paragraphs: false }).replace(/^= /, ''))) : [];
  // pair "label & = value" cells: the template writes "1 crown & = 5s"
  const after = box[2].slice(box[2].indexOf('\\end{center}') + 12);
  money = { title: html(t, { paragraphs: false }), rows, note: html(after, { paragraphs: false }),
    sections: ((/Sections?\s+([^)]*)/.exec(t) || [])[1] || '').match(/\b[A-Z]\b/g) || [] };
}

// Sections and problems
const secRe = /\\section\*\{Section\s+([A-Z])\s*\\quad\s*([^\\}]*?)\s*\\hfill\\normalsize\s*\(([^)]*)\)\}/g;
const heads = [...doc.matchAll(secRe)];
if (!heads.length) throw new Error('No \\section*{Section X \\quad Title \\hfill\\normalsize (...)} headings found.');
let n = 0;
const sections = heads.map((h, i) => {
  const body = doc.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : doc.length).split(/\\begin\{center\}\s*\\vspace\{1em\}[\s\S]*End of Paper/)[0];
  const firstProb = body.indexOf('\\begin{problem}');
  const intro = html(body.slice(0, firstProb < 0 ? body.length : firstProb));
  const problems = [...body.matchAll(/\\begin\{problem\}\{(\d+)\}([\s\S]*?)\\end\{problem\}/g)].map(pm => {
    const id = String(++n);
    let b = pm[2].replace(/\\answerline(\[[^\]]*\])?/g, '');
    const p = { id, marks: Number(pm[1]) };
    const mcqAt = b.indexOf('\\mcq{');
    const longM = /\\begin\{mcqlong\}([\s\S]*?)\\end\{mcqlong\}/.exec(b);
    const partsM = /\\begin\{parts\}([\s\S]*?)\\end\{parts\}/.exec(b);
    if (mcqAt >= 0) {
      let j = mcqAt + 4; const options = [];
      for (let k = 0; k < 5; k++) { const [g, e] = readGroup(b, j); options.push(html(g, { paragraphs: false })); j = e; }
      Object.assign(p, { type: 'mcq', text: html(b.slice(0, mcqAt)), options });
    } else if (longM) {
      Object.assign(p, { type: 'mcq', text: html(b.slice(0, longM.index)), options: envItems(longM[1]).map(x => html(x, { paragraphs: false })), long: true });
    } else if (partsM) {
      const parts = envItems(partsM[1]).map((x, k) => {
        const mk = /\\hfill\s*\[(\d+)\]\s*$/.exec(x);
        return { id: 'abcdefghij'[k], marks: mk ? Number(mk[1]) : 0, text: html(mk ? x.slice(0, mk.index) : x, { paragraphs: false }) };
      });
      Object.assign(p, { type: 'written', text: html(b.slice(0, partsM.index) + ' ' + b.slice(partsM.index + partsM[0].length)), parts });
    } else {
      const cAt = b.search(/\\textbf\{Constraints\.?\}/);
      const ex = /\\begin\{example\}([\s\S]*?)\\end\{example\}/.exec(b);
      const constraints = cAt >= 0 ? html(b.slice(cAt, ex ? ex.index : b.search(/\\task|$/)).replace(/\\textbf\{Constraints\.?\}/, ''), { paragraphs: false }) : '';
      const stop = [cAt, ex ? ex.index : -1, b.search(/\\task(?![a-zA-Z])/)].filter(x => x >= 0);
      Object.assign(p, { type: 'algo', text: html(b.slice(0, stop.length ? Math.min(...stop) : b.length)), constraints, example: ex ? html(ex[1], { paragraphs: false }) : '' });
      if (!/\\task(?![a-zA-Z])/.test(b)) warnings.add(`Problem ${id}: no \\mcq, parts or \\task; treated as a single written answer`);
    }
    return p;
  });
  return { id: h[1], title: h[2].trim(), marksNote: h[3].trim(), money: !!money?.sections.includes(h[1]), ...(intro ? { intro } : {}), problems };
});

const instructionsFile = 'paper/instructions.txt';
const instructions = existsSync(instructionsFile)
  ? readFileSync(instructionsFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  : ['Answer all problems. Your answers save automatically.'];

const PAPER = {
  id: basename(file, '.tex'), title, round, instructions,
  ...(money ? { money: { title: money.title, rows: money.rows, note: money.note } } : {}),
  sections,
};

// ---------- write ----------
const header = `// GENERATED from ${file} by scripts/tex-to-paper.js on ${new Date().toISOString()}.\n// Edit the .tex file (and paper/instructions.txt), then run \`npm run paper\`. Do not edit this file by hand.\n`;
writeFileSync('lib/paper.js', header + `export const PAPER = ${JSON.stringify(PAPER, null, 2)};

// Every answer field the server will accept, e.g. "1", "8a", "15".
export const ANSWER_KEYS = new Set(
  PAPER.sections.flatMap(s => s.problems.flatMap(p =>
    p.type === 'written' ? p.parts.map(pt => p.id + pt.id) : [p.id]))
);
`);
const points = Object.fromEntries(sections.flatMap(s => s.problems).filter(p => p.type === 'mcq').map(p => [p.id, p.marks]));
writeFileSync('lib/key.js', header + `// Multiple-choice answer key, used only by scripts/export.js. Never sent to browsers.
export const MCQ_KEY = ${JSON.stringify(key)};
export const MCQ_POINTS = ${JSON.stringify(points)};
`);

const count = sections.reduce((t, s) => t + s.problems.length, 0);
const marks = sections.reduce((t, s) => t + s.problems.reduce((u, p) => u + p.marks, 0), 0);
console.log(`Paper: ${title} · ${round} · ${count} problems · ${marks} marks · sections ${sections.map(s => `${s.id}(${s.problems.length})`).join(' ')}`);
const mcqs = Object.keys(points);
const missing = mcqs.filter(q => !key[q]);
console.log(missing.length ? `Answer key: MISSING for problems ${missing.join(', ')} (add the table inside \\ifanswers)` : `Answer key: ${mcqs.length} multiple-choice answers found`);
for (const w of warnings) console.log('Note: ignored ' + w);
