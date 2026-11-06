import type { Pool, PoolClient } from './pool.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Trusted, server-resolved request context. `organizationId` must only be set after the caller
 * has proven membership (control plane) or a verified route lookup (public plane). It is
 * applied with `set_config(..., is_local => true)`, so it cannot leak across pooled
 * connections or transactions.
 */
export interface TransactionContext {
  userId?: string | undefined;
  organizationId?: string | undefined;
}

export async function setUserContext(client: PoolClient, userId: string): Promise<void> {
  if (!isUuid(userId)) throw new TypeError('userId must be a UUID');
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
}

export async function setTenantContext(client: PoolClient, organizationId: string): Promise<void> {
  if (!isUuid(organizationId)) throw new TypeError('organizationId must be a UUID');
  await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
}

export async function withTransaction<T>(
  pool: Pool,
  context: TransactionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (context.userId !== undefined) await setUserContext(client, context.userId);
    if (context.organizationId !== undefined)
      await setTenantContext(client, context.organizationId);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** PostgreSQL SQLSTATE helpers for mapping constraint violations to domain errors. */
export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'constraint' in error
    ? String(error.constraint)
    : undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
