import { loadApiConfig } from '@eventhub/config';
import { simpleWebAuthnRelyingParty } from './adapters/simplewebauthn-passkeys.ts';
import { createPool } from '@eventhub/db';
import { InMemoryObjectStore, type ObjectStore } from '@eventhub/kernel';
import { LocalDirectoryObjectStore } from '@eventhub/kernel/object-stores';
import { CloudStorageObjectStore, cloudStorageBucket } from '@eventhub/kernel/gcs-object-store';
import { buildApp, loggerOptions } from './app.ts';
import { Argon2idPasswordHasher } from './adapters/argon2id-password-hasher.ts';
import { ResendEmailFeedbackReceiver } from './adapters/resend-email-feedback.ts';
import { DatabaseSessionAuthenticator } from './modules/identity/authenticator.ts';

const config = loadApiConfig(process.env);
const pool = createPool({
  connectionString: config.database.appUrl,
  applicationName: 'eventhub-api',
});
function selectObjectStore(): ObjectStore | null {
  const c = config.objectStore;
  if (!c) return null;
  if (c.adapter === 'gcs') return new CloudStorageObjectStore(cloudStorageBucket(c.bucket!));
  return c.adapter === 'local_directory'
    ? new LocalDirectoryObjectStore(c.directory!)
    : new InMemoryObjectStore();
}

const app = await buildApp({
  objectStore: selectObjectStore(),
  emailFeedback: config.emailWebhookSecret
    ? new ResendEmailFeedbackReceiver(config.emailWebhookSecret)
    : null,
  pool,
  authenticator: new DatabaseSessionAuthenticator(pool, {
    idleSeconds: config.auth.sessionIdleSeconds,
  }),
  passwordHasher: new Argon2idPasswordHasher(),
  identity: {
    ...config.auth,
    mfaEncryptionKey: config.mfa.encryptionKey,
    passkeys: config.passkeys ? simpleWebAuthnRelyingParty(config.passkeys) : null,
  },
  invitationTtlSeconds: config.invitations.ttlSeconds,
  logger: loggerOptions(config.logLevel),
  trustProxy: config.http.trustProxy,
  rateLimitPerMinute: config.rateLimitPerMinute,
  validateResponses: config.environment !== 'production',
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.http.host, port: config.http.port });
