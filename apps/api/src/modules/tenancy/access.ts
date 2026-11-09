import {
  AppError,
  isRole,
  notFound,
  roleHasPermission,
  roleRequiresMfa,
  type Permission,
  type Role,
} from '@eventhub/kernel';
import { setTenantContext, withTransaction, type Pool, type PoolClient } from '@eventhub/db';
import type { Principal } from '../identity/authenticator.ts';

export interface OrganizationAccess {
  organizationId: string;
  userId: string;
  role: Role;
  /** The organization requires two-step verification for Owners and Admins (ADR-0024). */
  requireMfaForAdmins: boolean;
  /** The caller's role is covered by that requirement and the caller has not set it up. */
  mfaBlocked: boolean;
}

export interface OrganizationAccessOptions {
  /**
   * Let an Owner/Admin who is blocked by the two-step verification requirement through, so the
   * route can explain the block. Only the organization profile read uses this.
   */
  allowMfaBlocked?: boolean;
}

/**
 * Resolves tenant context server-side and runs `fn` in one transaction:
 *  1. set app.user_id (RLS then exposes only the caller's own memberships);
 *  2. look up an *active* membership for the URL locator — the URL value is never trusted as
 *     authorization evidence; a non-member gets the same 404 as a non-existent organization;
 *  3. deny by default unless the role explicitly grants `permission` (403 for members);
 *  4. if the organization requires two-step verification for Owners and Admins, deny those
 *     roles until they have set it up (403 mfa_required), unless the route opts out to explain;
 *  5. set app.organization_id so every subsequent statement is RLS-scoped to this tenant.
 */
export async function withOrganization<T>(
  pool: Pool,
  principal: Principal,
  organizationLocator: string,
  permission: Permission,
  fn: (client: PoolClient, access: OrganizationAccess) => Promise<T>,
  options: OrganizationAccessOptions = {},
): Promise<T> {
  return withTransaction(pool, { userId: principal.userId }, async (client) => {
    const { rows } = await client.query<{ role: string; require_mfa_for_admins: boolean }>(
      `SELECT m.role, o.require_mfa_for_admins
         FROM eventhub.membership m
         JOIN eventhub.organization o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
      [organizationLocator, principal.userId],
    );
    const role = rows[0]?.role;
    if (!isRole(role)) throw notFound('Organization');
    if (!roleHasPermission(role, permission)) {
      throw new AppError('forbidden', 'You do not have permission to perform this action.', {
        details: { reason: `missing_permission:${permission}` },
      });
    }
    const requireMfaForAdmins = rows[0]!.require_mfa_for_admins;
    let mfaBlocked = false;
    if (roleRequiresMfa(role, requireMfaForAdmins)) {
      const mfa = await client.query<{ enrolled: boolean }>(
        'SELECT eventhub.auth_mfa_required($1) AS enrolled',
        [principal.userId],
      );
      mfaBlocked = !mfa.rows[0]!.enrolled;
    }
    if (mfaBlocked && !options.allowMfaBlocked) {
      throw new AppError(
        'forbidden',
        'This organization requires two-step verification for Owners and Admins. Turn it on in your account to continue.',
        { details: { reason: 'mfa_required' } },
      );
    }
    await setTenantContext(client, organizationLocator);
    return fn(client, {
      organizationId: organizationLocator,
      userId: principal.userId,
      role,
      requireMfaForAdmins,
      mfaBlocked,
    });
  });
}
