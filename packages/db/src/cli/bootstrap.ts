import pg from 'pg';
import { bootstrapDatabase } from '../bootstrap.ts';

/**
 * Usage (operator, once per environment; values come from the secret manager, not files):
 *   DATABASE_ADMIN_URL=... EVENTHUB_MIGRATOR_PASSWORD=... EVENTHUB_APP_PASSWORD=... \
 *   EVENTHUB_WORKER_PASSWORD=... pnpm db:bootstrap
 * The target database is the one named in DATABASE_ADMIN_URL and must already exist.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`Missing required environment variable ${name}\n`);
    process.exit(1);
  }
  return v;
}

const adminUrl = required('DATABASE_ADMIN_URL');
const databaseName = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, ''));
if (!databaseName) {
  process.stderr.write('DATABASE_ADMIN_URL must name the target database\n');
  process.exit(1);
}
const client = new pg.Client({
  connectionString: adminUrl,
  application_name: 'eventhub-bootstrap',
});
await client.connect();
try {
  await bootstrapDatabase(client, databaseName, {
    migrator: required('EVENTHUB_MIGRATOR_PASSWORD'),
    app: required('EVENTHUB_APP_PASSWORD'),
    worker: required('EVENTHUB_WORKER_PASSWORD'),
  });
  process.stdout.write(`bootstrap complete for database ${databaseName}\n`);
} finally {
  await client.end();
}
