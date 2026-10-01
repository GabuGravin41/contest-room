// Per-student order of multiple-choice options.
// Each code sees the options of each problem in its own fixed order, so "the answer to 3 is B" shared
// between students is worthless. Answers are always stored as the ORIGINAL letter from the .tex file,
// so marking and the answer key are unaffected. The order is derived from the code, so it never changes
// for a student (reloads, device switches) and the flags script can recompute it.
import { createHash } from 'node:crypto';

export function permFor(code, qid, n) {
  const h = createHash('sha256').update(`${code}:${qid}:kio-shuffle`).digest();
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = h[i] % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  return p; // p[displayPosition] = original option index
}

export const shuffleOn = () => (process.env.SHUFFLE_MCQ ?? '1') !== '0';

export function paperFor(paper, code) {
  if (!shuffleOn()) return paper;
  return {
    ...paper,
    sections: paper.sections.map(s => ({
      ...s,
      problems: s.problems.map(p => p.type === 'mcq' ? { ...p, perm: permFor(code, p.id, p.options.length) } : p),
    })),
  };
}
