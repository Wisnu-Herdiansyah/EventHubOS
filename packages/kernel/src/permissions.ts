/**
 * Versioned permission catalog and tenant-scoped role policy.
 *
 * Deny by default: a permission is granted only if it appears explicitly in a role's set.
 * Unknown roles or permissions evaluate to false. UI visibility must never be used as
 * authorization; services call `roleHasPermission` (and RLS enforces tenant boundaries).
 * Changing this file requires bumping PERMISSION_CATALOG_VERSION and updating the matrix test.
 */

export const PERMISSION_CATALOG_VERSION = 2;

export const PERMISSIONS = [
  'organization.read',
  'organization.manage',
  'organization.transfer_ownership',
  'organization.delete_request',
  'membership.read',
  'membership.manage',
  'domain.read',
  'domain.manage',
  'template.manage',
  'integration.manage',
  'event.read',
  'event.create',
  'event.update',
  'event.publish',
  'event.archive',
  'page.edit',
  'asset.manage',
  'registration.manage',
  'registration.export_pii',
  'attendee.checkin',
  'communication.send',
  'report.read',
  'billing.read',
  'billing.manage',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Ordered from most to least authority; used for "cannot grant above your own role". */
export const ROLES = [
  'owner',
  'admin',
  'billing_admin',
  'event_manager',
  'content_editor',
  'registration_manager',
  'analyst',
  'viewer',
] as const;

export type Role = (typeof ROLES)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const without = (...excluded: Permission[]): Set<Permission> =>
  new Set(PERMISSIONS.filter((p) => !excluded.includes(p)));

const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: ALL,
  admin: without(
    'organization.transfer_ownership',
    'organization.delete_request',
    'billing.manage',
  ),
  billing_admin: new Set<Permission>(['organization.read', 'billing.read', 'billing.manage']),
  event_manager: new Set<Permission>([
    'organization.read',
    'event.read',
    'event.create',
    'event.update',
    'event.publish',
    'event.archive',
    'page.edit',
    'asset.manage',
    'registration.manage',
    'communication.send',
    'report.read',
  ]),
  content_editor: new Set<Permission>([
    'organization.read',
    'event.read',
    'page.edit',
    'asset.manage',
  ]),
  registration_manager: new Set<Permission>([
    'organization.read',
    'event.read',
    'registration.manage',
    'registration.export_pii',
    'attendee.checkin',
    'report.read',
  ]),
  analyst: new Set<Permission>(['organization.read', 'event.read', 'report.read']),
  viewer: new Set<Permission>(['organization.read', 'event.read']),
};

/**
 * Platform support access (ADR-0045, catalog v2): what EventHub staff can do in an organization
 * while its Owner or Admin has granted support access. Read-only, and no attendee data. It is not
 * a membership role: isRole() is false for it, so it can never be invited, assigned or granted.
 */
export const SUPPORT_ROLE = 'support';
export type AccessRole = Role | typeof SUPPORT_ROLE;
const SUPPORT_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'organization.read',
  'membership.read',
  'event.read',
  'report.read',
  'audit.read',
]);

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: unknown, permission: unknown): boolean {
  if (typeof permission !== 'string') return false;
  if (role === SUPPORT_ROLE) return SUPPORT_PERMISSIONS.has(permission as Permission);
  if (!isRole(role)) return false;
  return ROLE_PERMISSIONS[role].has(permission as Permission);
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].has(p));
}

/**
 * ORG-02: an inviter may only grant roles at or below their own authority, and only Owners
 * may grant Owner. Requires `membership.manage`.
 */
export function canAssignRole(actorRole: unknown, targetRole: unknown): boolean {
  if (!isRole(actorRole) || !isRole(targetRole)) return false;
  if (!roleHasPermission(actorRole, 'membership.manage')) return false;
  if (targetRole === 'owner') return actorRole === 'owner';
  return ROLES.indexOf(targetRole) >= ROLES.indexOf(actorRole);
}

/**
 * ADR-0024: roles that must have two-step verification when the organization requires it.
 * These are the roles that can change membership, settings and security posture.
 */
export const MFA_ENFORCED_ROLES: readonly Role[] = ['owner', 'admin'];

export function roleRequiresMfa(role: unknown, organizationRequiresMfa: boolean): boolean {
  return organizationRequiresMfa && isRole(role) && MFA_ENFORCED_ROLES.includes(role);
}
