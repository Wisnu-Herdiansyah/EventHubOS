import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a parameterised query (pool client inside a transaction). */
export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  connectionString: string;
  applicationName: string;
  max?: number;
  statementTimeoutMs?: number;
}

/**
 * All application SQL is schema-qualified or resolved through the `eventhub` search path.
 * Statement timeouts bound runaway queries so one tenant cannot monopolise connections.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    options: `-c search_path=eventhub -c statement_timeout=${options.statementTimeoutMs ?? 10_000}`,
  });
  // An idle client error must not crash the process; it is surfaced on next checkout.
  pool.on('error', () => undefined);
  return pool;
}
