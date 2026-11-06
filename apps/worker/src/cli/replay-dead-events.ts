import { parseArgs } from 'node:util';
import pg from 'pg';
import { replayDeadEvents } from '@eventhub/db';

/**
 * Operator tool (runbook: docs/operations/outbox-runbook.md). Returns dead-lettered outbox events
 * to the queue after the underlying cause is fixed. Runs as the least-privilege worker role.
 *
 *   DATABASE_WORKER_URL=... pnpm outbox:replay --event <uuid> [--event <uuid> ...]
 *   DATABASE_WORKER_URL=... pnpm outbox:replay --all-dead --confirm
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: {
    event: { type: 'string', multiple: true },
    'all-dead': { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
  },
});
const ids = values.event ?? [];
const fail = (msg: string): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
};
if (ids.length === 0 && !values['all-dead'])
  fail('Pass --event <uuid> (repeatable) or --all-dead --confirm.');
if (ids.length > 0 && values['all-dead']) fail('Use either --event or --all-dead, not both.');
if (values['all-dead'] && !values.confirm) fail('--all-dead requires --confirm.');
for (const id of ids) if (!UUID_RE.test(id)) fail(`Not an event UUID: ${id}`);
const url = process.env.DATABASE_WORKER_URL ?? fail('DATABASE_WORKER_URL is required.');

const client = new pg.Client({ connectionString: url, application_name: 'eventhub-outbox-replay' });
await client.connect();
try {
  const replayed = await replayDeadEvents(client, values['all-dead'] ? null : ids);
  process.stdout.write(
    `replayed ${replayed.length} event(s)${replayed.length ? `: ${replayed.join(', ')}` : ''}\n`,
  );
  const missing = ids.filter((id) => !replayed.includes(id.toLowerCase()));
  if (missing.length > 0)
    process.stdout.write(`not dead-lettered (skipped): ${missing.join(', ')}\n`);
} finally {
  await client.end();
}
