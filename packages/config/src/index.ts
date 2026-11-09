import { z } from 'zod';

/**
 * Typed, validated, environment-scoped configuration. Loading fails closed: a missing or
 * invalid critical value aborts startup. Error messages name the offending keys but never
 * echo values, because values may be secrets (connection strings embed passwords).
 */

export const DEPLOY_ENVIRONMENTS = ['local', 'ci', 'staging', 'production'] as const;
export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export class ConfigError extends Error {
  readonly keys: readonly string[];
  constructor(keys: readonly string[], reason: string) {
    super(`Invalid configuration (${reason}): ${keys.join(', ')}`);
    this.name = 'ConfigError';
    this.keys = keys;
  }
}

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'postgres:' || u.protocol === 'postgresql:';
    } catch {
      return false;
    }
  }, 'must be a postgres:// URL');

function isRemoteEnvironment(env: DeployEnvironment): boolean {
  return env === 'staging' || env === 'production';
}

/** Remote environments must use TLS to the database. */
function requiresTls(url: string): boolean {
  const mode = new URL(url).searchParams.get('sslmode');
  return mode === 'require' || mode === 'verify-ca' || mode === 'verify-full';
}

function parse<T extends z.ZodType>(
  schema: T,
  env: Readonly<Record<string, string | undefined>>,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? '(root)')))];
    throw new ConfigError(keys, 'missing or malformed');
  }
  return result.data;
}

function assertDatabaseTls(
  environment: DeployEnvironment,
  entries: Readonly<Record<string, string>>,
): void {
  if (!isRemoteEnvironment(environment)) return;
  const insecure = Object.entries(entries)
    .filter(([, url]) => !requiresTls(url))
    .map(([k]) => k);
  if (insecure.length > 0) {
    throw new ConfigError(insecure, `sslmode=require or stricter is mandatory in ${environment}`);
  }
}

const baseSchema = z.object({
  EVENTHUB_ENV: z.enum(DEPLOY_ENVIRONMENTS),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

const apiSchema = baseSchema.extend({
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_APP_URL: postgresUrl,
  // 'false' (default), 'true' (local/ci only), or a comma-separated list of trusted proxy IPs/CIDRs
  // (e.g. the admin web app's address) whose X-Forwarded-For is believed for client IPs.
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v, ctx): boolean | string[] => {
      if (v === 'false') return false;
      if (v === 'true') return true;
      const list = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ok =
        list.length > 0 &&
        list.every((s) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) && /[.:]/.test(s));
      if (!ok) {
        ctx.addIssue({ code: 'custom', message: 'Use false, true, or a list of IPs/CIDRs' });
        return z.NEVER;
      }
      return list;
    }),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  // Idle timeout (ADR-0018). Activity is recorded every 5 minutes, hence the 15-minute floor.
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(15).max(1440).default(60),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(50).default(5),
  LOGIN_LOCK_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  /**
   * 32 random bytes, base64, sealing authenticator-app secrets (ADR-0022). Required in staging and
   * production; without it locally, two-step verification reports itself as unavailable.
   */
  MFA_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || Buffer.from(v, 'base64').length === 32,
      'Must be 32 bytes, base64-encoded (e.g. openssl rand -base64 32)',
    ),
});

export interface ApiConfig {
  environment: DeployEnvironment;
  logLevel: (typeof LOG_LEVELS)[number];
  http: { host: string; port: number; trustProxy: boolean | string[] };
  database: { appUrl: string };
  rateLimitPerMinute: number;
  auth: {
    sessionTtlSeconds: number;
    sessionIdleSeconds: number;
    loginMaxFailures: number;
    loginLockSeconds: number;
  };
  invitations: { ttlSeconds: number };
  /** null: not configured (local/ci only), so MFA enrolment and sign-in report unavailable. */
  mfa: { encryptionKey: Buffer | null };
}

export function loadApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const c = parse(apiSchema, env);
  assertDatabaseTls(c.EVENTHUB_ENV, { DATABASE_APP_URL: c.DATABASE_APP_URL });
  if (c.TRUST_PROXY === true && isRemoteEnvironment(c.EVENTHUB_ENV)) {
    // Trusting every hop would let any client spoof its IP and dodge per-IP auth rate limits.
    throw new ConfigError(
      ['TRUST_PROXY'],
      `list the trusted proxy addresses explicitly in ${c.EVENTHUB_ENV}`,
    );
  }
  if (!c.MFA_ENCRYPTION_KEY && isRemoteEnvironment(c.EVENTHUB_ENV)) {
    throw new ConfigError(['MFA_ENCRYPTION_KEY'], `is required in ${c.EVENTHUB_ENV}`);
  }
  return {
    environment: c.EVENTHUB_ENV,
    logLevel: c.LOG_LEVEL,
    http: { host: c.HTTP_HOST, port: c.HTTP_PORT, trustProxy: c.TRUST_PROXY },
    database: { appUrl: c.DATABASE_APP_URL },
    rateLimitPerMinute: c.RATE_LIMIT_PER_MINUTE,
    auth: {
      sessionTtlSeconds: c.SESSION_TTL_HOURS * 3600,
      sessionIdleSeconds: c.SESSION_IDLE_MINUTES * 60,
      loginMaxFailures: c.LOGIN_MAX_FAILURES,
      loginLockSeconds: c.LOGIN_LOCK_SECONDS,
    },
    invitations: { ttlSeconds: c.INVITATION_TTL_HOURS * 3600 },
    mfa: {
      encryptionKey: c.MFA_ENCRYPTION_KEY ? Buffer.from(c.MFA_ENCRYPTION_KEY, 'base64') : null,
    },
  };
}

/**
 * Event broker adapters. `postgres_outbox` (ADR-0009): the durable PostgreSQL outbox, delivered
 * to this worker's in-process consumers. Allowed in every environment.
 */
export const EVENT_PUBLISHER_ADAPTERS = ['postgres_outbox'] as const;

/**
 * Email adapters (ADR-0008): `resend` (production provider), plus the local fakes `in_memory` (CI)
 * and `local_file` (JSON files for local development), which are refused in staging/production.
 */
export const EMAIL_SENDER_ADAPTERS = ['resend', 'in_memory', 'local_file'] as const;
const LOCAL_EMAIL_SENDERS: ReadonlySet<string> = new Set(['in_memory', 'local_file']);

/** `Display Name <local@domain>` or a bare address. */
const EMAIL_FROM_RE = /^(?:[^<>\r\n]{1,100} )?<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/;

const workerSchema = baseSchema.extend({
  DATABASE_WORKER_URL: postgresUrl,
  EVENT_PUBLISHER: z.enum(EVENT_PUBLISHER_ADAPTERS),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  OUTBOX_HEALTH_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  OUTBOX_LAG_WARN_SECONDS: z.coerce.number().int().min(10).max(86_400).default(300),
  EMAIL_SENDER: z.enum(EMAIL_SENDER_ADAPTERS),
  EMAIL_LOCAL_DIR: z.string().min(1).optional(),
  EMAIL_FROM: z.string().regex(EMAIL_FROM_RE).optional(),
  RESEND_API_KEY: z.string().min(10).max(200).optional(),
  RESEND_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://api.resend.com'),
  RESEND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  APP_BASE_URL: z.url({ protocol: /^https?$/ }),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  // Password reset links are short-lived (ADR-0015).
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(10).max(240).default(60),
  // Secret for deterministic, retry-stable verification tokens (ADR-0008).
  EMAIL_TOKEN_SECRET: z.string().min(32).max(512),
  /**
   * Public event site address with a {handle} placeholder, e.g. https://{handle}.eventhub.example
   * (ADR-0021). Used for registration cancel links (ADR-0023); without it emails say to contact
   * the organizer instead.
   */
  PUBLIC_SITE_URL: z
    .string()
    .regex(/^https?:\/\/\{handle\}\.[a-z0-9.-]+(:\d+)?$/i, 'e.g. https://{handle}.eventhub.example')
    .optional(),
});

export interface WorkerConfig {
  environment: DeployEnvironment;
  logLevel: (typeof LOG_LEVELS)[number];
  database: { workerUrl: string };
  eventPublisher: (typeof EVENT_PUBLISHER_ADAPTERS)[number];
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    healthIntervalMs: number;
    lagWarnSeconds: number;
  };
  email: {
    sender: (typeof EMAIL_SENDER_ADAPTERS)[number];
    localDir: string | undefined;
    /** Present only when sender is `resend`. The API key is a secret: never log this object. */
    resend: { apiKey: string; from: string; baseUrl: string; timeoutMs: number } | undefined;
  };
  appBaseUrl: string;
  /** {handle} template of public sites, or null. */
  publicSiteUrl: string | null;
  emailVerificationTtlSeconds: number;
  passwordResetTtlSeconds: number;
  /** Secret: never log. */
  emailTokenSecret: string;
}

export function loadWorkerConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const c = parse(workerSchema, env);
  assertDatabaseTls(c.EVENTHUB_ENV, { DATABASE_WORKER_URL: c.DATABASE_WORKER_URL });
  if (c.EMAIL_SENDER === 'local_file' && !c.EMAIL_LOCAL_DIR) {
    throw new ConfigError(['EMAIL_LOCAL_DIR'], 'required when EMAIL_SENDER=local_file');
  }
  if (c.EMAIL_SENDER === 'resend') {
    const missing = [
      ...(c.RESEND_API_KEY ? [] : ['RESEND_API_KEY']),
      ...(c.EMAIL_FROM ? [] : ['EMAIL_FROM']),
    ];
    if (missing.length > 0) throw new ConfigError(missing, 'required when EMAIL_SENDER=resend');
  }
  if (isRemoteEnvironment(c.EVENTHUB_ENV)) {
    // Local fakes must fail closed remotely. Each key is reported on its own so the remaining
    // blocker is explicit.
    const refused = [
      ...(LOCAL_EMAIL_SENDERS.has(c.EMAIL_SENDER) ? ['EMAIL_SENDER'] : []),
      ...(c.EMAIL_SENDER === 'resend' && !c.RESEND_BASE_URL.startsWith('https://')
        ? ['RESEND_BASE_URL']
        : []),
      ...(c.APP_BASE_URL.startsWith('https://') ? [] : ['APP_BASE_URL']),
      ...(c.PUBLIC_SITE_URL && !c.PUBLIC_SITE_URL.startsWith('https://')
        ? ['PUBLIC_SITE_URL']
        : []),
    ];
    if (refused.length > 0) {
      throw new ConfigError(
        refused,
        `refused in ${c.EVENTHUB_ENV}: local-only email adapters and non-HTTPS URLs`,
      );
    }
  }
  return {
    environment: c.EVENTHUB_ENV,
    logLevel: c.LOG_LEVEL,
    database: { workerUrl: c.DATABASE_WORKER_URL },
    eventPublisher: c.EVENT_PUBLISHER,
    outbox: {
      pollIntervalMs: c.OUTBOX_POLL_INTERVAL_MS,
      batchSize: c.OUTBOX_BATCH_SIZE,
      maxAttempts: c.OUTBOX_MAX_ATTEMPTS,
      healthIntervalMs: c.OUTBOX_HEALTH_INTERVAL_MS,
      lagWarnSeconds: c.OUTBOX_LAG_WARN_SECONDS,
    },
    email: {
      sender: c.EMAIL_SENDER,
      localDir: c.EMAIL_LOCAL_DIR,
      resend:
        c.EMAIL_SENDER === 'resend'
          ? {
              apiKey: c.RESEND_API_KEY!,
              from: c.EMAIL_FROM!,
              baseUrl: c.RESEND_BASE_URL.replace(/\/+$/, ''),
              timeoutMs: c.RESEND_TIMEOUT_MS,
            }
          : undefined,
    },
    appBaseUrl: c.APP_BASE_URL.replace(/\/+$/, ''),
    publicSiteUrl: c.PUBLIC_SITE_URL ?? null,
    emailVerificationTtlSeconds: c.EMAIL_VERIFICATION_TTL_HOURS * 3600,
    passwordResetTtlSeconds: c.PASSWORD_RESET_TTL_MINUTES * 60,
    emailTokenSecret: c.EMAIL_TOKEN_SECRET,
  };
}

const migratorSchema = baseSchema.extend({ DATABASE_MIGRATOR_URL: postgresUrl });

export interface MigratorConfig {
  environment: DeployEnvironment;
  database: { migratorUrl: string };
}

export function loadMigratorConfig(
  env: Readonly<Record<string, string | undefined>>,
): MigratorConfig {
  const c = parse(migratorSchema, env);
  assertDatabaseTls(c.EVENTHUB_ENV, { DATABASE_MIGRATOR_URL: c.DATABASE_MIGRATOR_URL });
  return { environment: c.EVENTHUB_ENV, database: { migratorUrl: c.DATABASE_MIGRATOR_URL } };
}
