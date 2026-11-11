import {
  AppError,
  isRole,
  notFound,
  roleHasPermission,
  roleRequiresMfa,
  SUPPORT_ROLE,
  type AccessRole,
  type Permission,
} from '@eventhub/kernel';
import {
  setTenantContext,
  withTransaction,
  writeAudit,
  type Pool,
  type PoolClient,
} from '@eventhub/db';
import type { Principal } from '../identity/authenticator.ts';

export interface OrganizationAccess {
  organizationId: string;
  userId: string;
  /** A membership role, or 'support' for platform staff with granted support access (ADR-0045). */
  role: AccessRole;
  /** When the caller's support access ends; null for members. */
  supportUntil: Date | null;
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
 *
 * A caller who is not a member but is platform staff, with two-step verification, while the
 * organization has granted support access, gets the read-only 'support' role (ADR-0045). Each
 * such request is written to the organization's audit log.
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
    let role: AccessRole;
    let supportUntil: Date | null = null;
    const memberRole = rows[0]?.role;
    if (isRole(memberRole)) {
      role = memberRole;
    } else {
      // Not a member: only platform support with an active grant gets in; anyone else sees the
      // same 404 as for an organization that does not exist.
      const support = await client.query<{ until: Date | null }>(
        'SELECT eventhub.support_access_until($1, $2) AS until',
        [organizationLocator, principal.userId],
      );
      supportUntil = support.rows[0]?.until ?? null;
      if (!supportUntil) throw notFound('Organization');
      role = SUPPORT_ROLE;
    }
    if (!roleHasPermission(role, permission)) {
      throw new AppError('forbidden', 'You do not have permission to perform this action.', {
        details: { reason: `missing_permission:${permission}` },
      });
    }
    const requireMfaForAdmins = rows[0]?.require_mfa_for_admins ?? false;
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
    if (role === SUPPORT_ROLE) {
      await writeAudit(client, {
        organizationId: organizationLocator,
        actor: { type: 'platform_support', id: principal.userId },
        action: 'support.accessed',
        targetType: 'organization',
        targetId: organizationLocator,
        correlationId: principal.correlationId ?? 'unknown',
        metadata: { permission },
      });
    }
    return fn(client, {
      organizationId: organizationLocator,
      userId: principal.userId,
      role,
      supportUntil,
      requireMfaForAdmins,
      mfaBlocked,
    });
  });
}
