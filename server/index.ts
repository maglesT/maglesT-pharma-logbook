import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { role: config.DB_APP_ROLE });
const app = await buildApp({ sql, logger: true, cookieSecure: config.COOKIE_SECURE });

await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await sql.end();
    process.exit(0);
  });
}
