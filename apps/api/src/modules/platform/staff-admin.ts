import { randomUUID } from 'node:crypto';
import type { Pool } from '@eventhub/db';

/**
 * Operator-only staff management (ADR-0045), run with migrator credentials through
 * `pnpm platform:staff`. There is no API or web route that does this, so no signed-in account
 * can make itself or anyone else staff. Each change is audited at platform level with the
 * operator's name.
 */
export type StaffAction = 'grant' | 'revoke';

const OPERATOR_RE = /^[A-Za-z0-9 ._@-]{2,80}$/;

export class StaffAdminError extends Error {}

export async function setPlatformStaff(
  migrator: Pool,
  input: { action: StaffAction; email: string; operator: string },
): Promise<'granted' | 'revoked' | 'unchanged'> {
  if (!OPERATOR_RE.test(input.operator)) {
    throw new StaffAdminError('Give your own name with --by (letters, digits, spaces, . _ @ -).');
  }
  const client = await migrator.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'SELECT id FROM eventhub.app_user WHERE lower(email) = lower($1)',
      [input.email.trim()],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new StaffAdminError('No account has that email address.');
    const result =
      input.action === 'grant'
        ? await client.query(
            `INSERT INTO eventhub.platform_staff (user_id) VALUES ($1)
             ON CONFLICT (user_id) DO UPDATE SET granted_at = now(), revoked_at = NULL
               WHERE eventhub.platform_staff.revoked_at IS NOT NULL`,
            [userId],
          )
        : await client.query(
            `UPDATE eventhub.platform_staff SET revoked_at = now()
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId],
          );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'unchanged';
    }
    await client.query(
      `INSERT INTO eventhub.audit_event
         (organization_id, actor_type, actor_id, action, target_type, target_id, correlation_id,
          metadata)
       VALUES (NULL, 'system', NULL, $1, 'user', $2, $3, jsonb_build_object('operator', $4::text))`,
      [
        input.action === 'grant' ? 'platform.staff_granted' : 'platform.staff_revoked',
        userId,
        `cli-${randomUUID()}`,
        input.operator,
      ],
    );
    await client.query('COMMIT');
    return input.action === 'grant' ? 'granted' : 'revoked';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
