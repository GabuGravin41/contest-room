// Usage:
//   npm run students -- students.csv          (columns: name,school,county,candidate_no)
//   npm run students -- --blank 50            (50 codes with no names, e.g. for the team to test)
// Writes out/codes-<timestamp>.csv with each student's code, ready for mail-merge / SMS.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { db } from '../lib/server.js';
import { parseCSV, toCSV } from './csv.js';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const gen = () => 'KIO' + Array.from({ length: 8 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
export const pretty = c => `${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}`;

const args = process.argv.slice(2);
let people;
if (args[0] === '--blank') people = Array.from({ length: Number(args[1] || 10) }, (_, i) => ({ name: `Test ${i + 1}` }));
else if (args[0]) people = parseCSV(readFileSync(args[0], 'utf8'));
else { console.log('Give a CSV file or --blank N'); process.exit(1); }

const sql = db();
const out = [];
for (const p of people) {
  for (;;) {
    const code = gen();
    const r = await sql`insert into students (code, name, school, county, candidate_no)
      values (${code}, ${p.name || null}, ${p.school || null}, ${p.county || null}, ${p.candidate_no || null})
      on conflict do nothing returning code`;
    if (r.length) { out.push({ ...p, code: pretty(code) }); break; }
  }
}
mkdirSync('out', { recursive: true });
const file = `out/codes-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
writeFileSync(file, toCSV(['code', 'name', 'school', 'county', 'candidate_no'], out));
console.log(`Added ${out.length} students. Codes written to ${file}`);
await sql.end();
