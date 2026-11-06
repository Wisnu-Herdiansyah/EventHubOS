import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { loadWorkerConfig } from '@eventhub/config';
import { createPool } from '@eventhub/db';
import { InMemoryEventPublisher, LOG_REDACT_PATHS, type EventPublisher } from '@eventhub/kernel';
import { relayOnce } from './outbox-relay.ts';

const config = loadWorkerConfig(process.env);
const logger = pino({
  level: config.logLevel,
  redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
});

function selectPublisher(name: typeof config.eventPublisher): EventPublisher {
  switch (name) {
    case 'in_memory':
      // Local/CI only (config refuses it in staging/production). A durable broker adapter
      // is blocked on the queue/broker provider decision.
      return new InMemoryEventPublisher();
  }
}

const pool = createPool({
  connectionString: config.database.workerUrl,
  applicationName: 'eventhub-worker',
  max: 2,
});
const publisher = selectPublisher(config.eventPublisher);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

logger.info({ adapter: publisher.name }, 'outbox relay started');
while (!controller.signal.aborted) {
  try {
    const stats = await relayOnce(pool, publisher, config.outbox, logger);
    if (stats.published + stats.retried + stats.deadLettered > 0) logger.info(stats, 'relay pass');
  } catch (error) {
    logger.error({ err: error }, 'relay pass failed');
  }
  await sleep(config.outbox.pollIntervalMs, undefined, { signal: controller.signal }).catch(
    () => undefined,
  );
}
await pool.end();
logger.info('outbox relay stopped');
