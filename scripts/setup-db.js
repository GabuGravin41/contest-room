// Creates the tables. Safe to run more than once.
import { readFileSync } from 'node:fs';
import { db } from '../lib/server.js';
const sql = db();
await sql.unsafe(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
console.log('Database ready.');
await sql.end();
