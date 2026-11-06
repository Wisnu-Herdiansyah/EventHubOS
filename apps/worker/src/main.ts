import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { loadWorkerConfig } from '@eventhub/config';
import { createPool } from '@eventhub/db';
import { InMemoryEmailSender, LOG_REDACT_PATHS, type EmailSender } from '@eventhub/kernel';
import { LocalFileEmailSender } from './adapters/local-file-email-sender.ts';
import { sendVerificationEmailConsumer } from './consumers/send-verification-email.ts';
import { LocalDispatchPublisher } from './local-dispatch-publisher.ts';
import { relayOnce } from './outbox-relay.ts';

const config = loadWorkerConfig(process.env);
const logger = pino({
  level: config.logLevel,
  redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
});

function selectEmailSender(): EmailSender {
  switch (config.email.sender) {
    case 'in_memory':
      return new InMemoryEmailSender();
    case 'local_file':
      return new LocalFileEmailSender(config.email.localDir!);
  }
}

// Relay + consumer transactions run concurrently, so the pool needs headroom.
const pool = createPool({
  connectionString: config.database.workerUrl,
  applicationName: 'eventhub-worker',
  max: 4,
});
const consumers = [
  sendVerificationEmailConsumer(selectEmailSender(), {
    appBaseUrl: config.appBaseUrl,
    ttlSeconds: config.emailVerificationTtlSeconds,
  }),
];
// Only local dispatch exists until the broker decision (D5); config refuses it remotely.
const publisher = new LocalDispatchPublisher(pool, consumers);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

logger.info(
  { adapter: publisher.name, email: config.email.sender, consumers: consumers.map((c) => c.name) },
  'outbox relay started',
);
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
