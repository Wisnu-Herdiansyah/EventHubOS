import 'server-only';
import { ROLES, canAssignRole, roleHasPermission, type Permission } from '@eventhub/kernel';

/**
 * What the signed-in user may do, from the same permission catalog the API enforces. Used only to
 * decide which controls to show; every action is still authorized by the API.
 */
export function can(role: string, permission: Permission): boolean {
  return roleHasPermission(role, permission);
}

export interface TeamAbilities {
  canRead: boolean;
  canManage: boolean;
  /** Roles this user may grant (ORG-02: at or below their own; only Owners grant Owner). */
  assignableRoles: string[];
}

export function teamAbilities(role: string): TeamAbilities {
  return {
    canRead: roleHasPermission(role, 'membership.read'),
    canManage: roleHasPermission(role, 'membership.manage'),
    assignableRoles: ROLES.filter((target) => canAssignRole(role, target)),
  };
}

/** A member's role can be changed, or the member removed, only by someone who could grant it. */
export function canManageMember(actorRole: string, memberRole: string): boolean {
  return canAssignRole(actorRole, memberRole);
}

export interface SettingsAbilities {
  /** Name, legal name, language, time zone (organization.manage). */
  canEditProfile: boolean;
  /** The billing contact is personal data, returned only with billing.read. */
  canReadBilling: boolean;
  canEditBilling: boolean;
  /** Whether the settings page has anything for this role. */
  canOpen: boolean;
}

export function settingsAbilities(role: string): SettingsAbilities {
  const canEditProfile = roleHasPermission(role, 'organization.manage');
  const canReadBilling = roleHasPermission(role, 'billing.read');
  const canEditBilling = roleHasPermission(role, 'billing.manage');
  return {
    canEditProfile,
    canReadBilling,
    canEditBilling,
    canOpen: canEditProfile || canReadBilling || canEditBilling,
  };
}
