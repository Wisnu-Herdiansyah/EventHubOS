import { loadApiConfig } from '@eventhub/config';
import { simpleWebAuthnRelyingParty } from './adapters/simplewebauthn-passkeys.ts';
import { createPool } from '@eventhub/db';
import {
  InMemoryBreachedPasswordChecker,
  InMemoryObjectStore,
  type BreachedPasswordChecker,
  type ObjectStore,
} from '@eventhub/kernel';
import { LocalDirectoryObjectStore } from '@eventhub/kernel/object-stores';
import { CloudStorageObjectStore, cloudStorageBucket } from '@eventhub/kernel/gcs-object-store';
import {
  SupabaseStorageObjectStore,
  supabaseStorageBucket,
} from '@eventhub/kernel/supabase-object-store';
import { buildApp, loggerOptions } from './app.ts';
import { Argon2idPasswordHasher } from './adapters/argon2id-password-hasher.ts';
import { ResendEmailFeedbackReceiver } from './adapters/resend-email-feedback.ts';
import { PwnedPasswordsChecker } from './adapters/pwned-passwords-checker.ts';
import { DatabaseSessionAuthenticator } from './modules/identity/authenticator.ts';

const config = loadApiConfig(process.env);
const pool = createPool({
  connectionString: config.database.appUrl,
  applicationName: 'eventhub-api',
});
function selectObjectStore(): ObjectStore | null {
  const c = config.objectStore;
  if (!c) return null;
  if (c.adapter === 'supabase') {
    return new SupabaseStorageObjectStore(
      supabaseStorageBucket({ ...c.supabase!, bucket: c.bucket! }),
    );
  }
  if (c.adapter === 'gcs') return new CloudStorageObjectStore(cloudStorageBucket(c.bucket!));
  return c.adapter === 'local_directory'
    ? new LocalDirectoryObjectStore(c.directory!)
    : new InMemoryObjectStore();
}

// The app's logger exists only once the app is built; until then a skipped check is not logged.
let logUnavailable: (reason: string) => void = () => undefined;
function selectBreachedPasswords(): BreachedPasswordChecker | null {
  if (config.breachedPasswordCheck === 'off') return null; // pragma: allowlist secret (a setting name, not a secret)
  if (config.breachedPasswordCheck === 'in_memory') return new InMemoryBreachedPasswordChecker(); // pragma: allowlist secret (a setting name, not a secret)
  return new PwnedPasswordsChecker({ onUnavailable: (reason) => logUnavailable(reason) });
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
    breachedPasswords: selectBreachedPasswords(),
  },
  invitationTtlSeconds: config.invitations.ttlSeconds,
  logger: loggerOptions(config.logLevel),
  trustProxy: config.http.trustProxy,
  visitorAddressKey: config.visitorAddressKey,
  rateLimitPerMinute: config.rateLimitPerMinute,
  validateResponses: config.environment !== 'production',
});

// ADR-0078: the password was accepted on length alone; never the password or its hash.
logUnavailable = (reason) =>
  app.log.warn(
    { event: 'breached_password_check_skipped', reason },
    'breached-password check skipped',
  );

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.http.host, port: config.http.port });
