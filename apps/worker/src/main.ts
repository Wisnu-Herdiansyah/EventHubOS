import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { loadWorkerConfig } from '@eventhub/config';
import { createPool, outboxHealth } from '@eventhub/db';
import { InMemoryEmailSender, LOG_REDACT_PATHS, type EmailSender } from '@eventhub/kernel';
import { LocalFileEmailSender } from './adapters/local-file-email-sender.ts';
import { ResendEmailSender } from './adapters/resend-email-sender.ts';
import { sendInvitationEmailConsumer } from './consumers/send-invitation-email.ts';
import {
  sendPasswordChangedEmailConsumer,
  sendPasswordResetEmailConsumer,
} from './consumers/send-password-reset-email.ts';
import { sendVerificationEmailConsumer } from './consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from './outbox-dispatch-publisher.ts';
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
    case 'resend':
      return new ResendEmailSender(config.email.resend!);
  }
}

// Relay + consumer transactions run concurrently, so the pool needs headroom.
const pool = createPool({
  connectionString: config.database.workerUrl,
  applicationName: 'eventhub-worker',
  max: 4,
});
const emailSender = selectEmailSender();
const consumers = [
  sendVerificationEmailConsumer(emailSender, {
    appBaseUrl: config.appBaseUrl,
    ttlSeconds: config.emailVerificationTtlSeconds,
    tokenSecret: config.emailTokenSecret,
  }),
  sendInvitationEmailConsumer(emailSender, {
    appBaseUrl: config.appBaseUrl,
    tokenSecret: config.emailTokenSecret,
  }),
  sendPasswordResetEmailConsumer(emailSender, {
    appBaseUrl: config.appBaseUrl,
    ttlSeconds: config.passwordResetTtlSeconds,
    tokenSecret: config.emailTokenSecret,
  }),
  sendPasswordChangedEmailConsumer(emailSender, { appBaseUrl: config.appBaseUrl }),
];
// PostgreSQL outbox broker (ADR-0009): the outbox table is the durable queue.
const publisher = new OutboxDispatchPublisher(pool, consumers);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

/**
 * Health snapshot for alerting (ADR-0009, runbook). Log-based until the observability stack is
 * chosen: alert on `outbox health` records at level warn/error.
 */
let lastHealthAt = 0;
async function reportHealth(): Promise<void> {
  if (Date.now() - lastHealthAt < config.outbox.healthIntervalMs) return;
  lastHealthAt = Date.now();
  try {
    const h = await outboxHealth(pool);
    const lagging = h.oldestDueAgeSeconds >= config.outbox.lagWarnSeconds;
    const context = { ...h, lagWarnSeconds: config.outbox.lagWarnSeconds };
    if (h.dead > 0) logger.error(context, 'outbox health: dead-lettered events need attention');
    else if (lagging) logger.warn(context, 'outbox health: delivery is lagging');
    else logger.info(context, 'outbox health');
  } catch (error) {
    logger.error({ err: error }, 'outbox health check failed');
  }
}

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
  await reportHealth();
  await sleep(config.outbox.pollIntervalMs, undefined, { signal: controller.signal }).catch(
    () => undefined,
  );
}
await pool.end();
logger.info('outbox relay stopped');
