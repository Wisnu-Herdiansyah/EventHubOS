import pg from 'pg';
import { loadMigratorConfig } from '@eventhub/config';
import { loadMigrations, migrate } from '../migrate.ts';

const config = loadMigratorConfig(process.env);
const client = new pg.Client({
  connectionString: config.database.migratorUrl,
  application_name: 'eventhub-migrate',
});
await client.connect();
try {
  const result = await migrate(client, await loadMigrations());
  process.stdout.write(
    `migrations: applied [${result.applied.join(', ')}], already applied ${result.alreadyApplied.length}\n`,
  );
} finally {
  await client.end();
}
