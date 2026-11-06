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
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
});

export interface ApiConfig {
  environment: DeployEnvironment;
  logLevel: (typeof LOG_LEVELS)[number];
  http: { host: string; port: number; trustProxy: boolean };
  database: { appUrl: string };
  rateLimitPerMinute: number;
}

export function loadApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const c = parse(apiSchema, env);
  assertDatabaseTls(c.EVENTHUB_ENV, { DATABASE_APP_URL: c.DATABASE_APP_URL });
  return {
    environment: c.EVENTHUB_ENV,
    logLevel: c.LOG_LEVEL,
    http: { host: c.HTTP_HOST, port: c.HTTP_PORT, trustProxy: c.TRUST_PROXY },
    database: { appUrl: c.DATABASE_APP_URL },
    rateLimitPerMinute: c.RATE_LIMIT_PER_MINUTE,
  };
}

/** Event broker adapters. Only the in-memory fake exists until the broker decision is made. */
export const EVENT_PUBLISHER_ADAPTERS = ['in_memory'] as const;

const workerSchema = baseSchema.extend({
  DATABASE_WORKER_URL: postgresUrl,
  EVENT_PUBLISHER: z.enum(EVENT_PUBLISHER_ADAPTERS),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
});

export interface WorkerConfig {
  environment: DeployEnvironment;
  logLevel: (typeof LOG_LEVELS)[number];
  database: { workerUrl: string };
  eventPublisher: (typeof EVENT_PUBLISHER_ADAPTERS)[number];
  outbox: { pollIntervalMs: number; batchSize: number; maxAttempts: number };
}

export function loadWorkerConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const c = parse(workerSchema, env);
  assertDatabaseTls(c.EVENTHUB_ENV, { DATABASE_WORKER_URL: c.DATABASE_WORKER_URL });
  if (c.EVENT_PUBLISHER === 'in_memory' && isRemoteEnvironment(c.EVENTHUB_ENV)) {
    throw new ConfigError(
      ['EVENT_PUBLISHER'],
      `in_memory publisher is not durable and is refused in ${c.EVENTHUB_ENV}; a broker adapter decision is required`,
    );
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
    },
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
