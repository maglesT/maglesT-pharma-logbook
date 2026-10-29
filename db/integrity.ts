// Runs the integrity check (LB-23) from the command line, e.g. after restoring a backup.
// Exit code 1 when problems are found. Usage: DATABASE_URL=... [DB_APP_ROLE=logbook_app] npm run integrity
import { connect } from '../server/db.js';
import { runIntegrityCheck } from '../server/integrity.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const sql = connect(url, { role: process.env.DB_APP_ROLE });
const r = await runIntegrityCheck(sql);
console.log(`entries: ${r.entries}, signatures: ${r.signatures}, problems: ${r.problems.length}`);
for (const p of r.problems.slice(0, 50)) console.log(`  ${p}`);
await sql.end();
process.exit(r.problems.length ? 1 : 0);
