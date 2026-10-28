// First-time setup: creates an admin account with a temporary password (printed once).
// Usage: MIGRATION_DATABASE_URL=... npm run create-admin -- <username> "<Full Name>"
import { connect } from '../server/db.js';
import { audit } from '../server/audit.js';
import { hashPassword, temporaryPassword } from '../server/passwords.js';

const [username, fullName] = process.argv.slice(2);
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url || !username || !fullName) {
  console.error('usage: create-admin <username> "<Full Name>" (needs MIGRATION_DATABASE_URL)');
  process.exit(1);
}
const sql = connect(url);
const temp = temporaryPassword();
const hash = await hashPassword(temp);
await sql.begin(async (tx) => {
  const [u] = await tx<{ id: number }[]>`
    insert into users (username, full_name, password_hash) values (${username.toLowerCase()}, ${fullName}, ${hash})
    returning id::int`;
  await tx`insert into user_roles (user_id, role) values (${u!.id}, 'admin')`;
  await audit(tx, { actorId: null, action: 'user.created', objectType: 'user', objectId: u!.id,
    new: { username: username.toLowerCase(), fullName, roles: ['admin'] }, reason: 'initial admin (setup script)' });
});
console.log(`Admin ${username} created. Temporary password (change at first login): ${temp}`);
await sql.end();
