import { parseArgs } from 'node:util';
import { loadMigratorConfig } from '@eventhub/config';
import { createPool } from '@eventhub/db';
import { setPlatformStaff, StaffAdminError } from '../modules/platform/staff-admin.ts';

/**
 * Grant or revoke EventHub platform staff (ADR-0045). Operators only: needs DATABASE_MIGRATOR_URL.
 *
 *   pnpm platform:staff grant  person@example.com --by "Operator Name"
 *   pnpm platform:staff revoke person@example.com --by "Operator Name"
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { by: { type: 'string' } },
});
const [action, email] = positionals;
if ((action !== 'grant' && action !== 'revoke') || !email || !values.by) {
  process.stderr.write('Usage: pnpm platform:staff grant|revoke <email> --by "<your name>"\n');
  process.exit(2);
}
const config = loadMigratorConfig(process.env);
const pool = createPool({
  connectionString: config.database.migratorUrl,
  applicationName: 'eventhub-platform-staff',
});
try {
  const result = await setPlatformStaff(pool, { action, email, operator: values.by });
  process.stdout.write(`${result}\n`);
  if (result !== 'unchanged') {
    process.stdout.write(
      action === 'grant'
        ? 'They must turn on two-step verification before they can use platform tools.\n'
        : 'Their platform access ended now, including any support access.\n',
    );
  }
} catch (error) {
  if (error instanceof StaffAdminError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
