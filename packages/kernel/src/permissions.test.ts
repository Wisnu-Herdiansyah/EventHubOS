import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_CATALOG_VERSION,
  ROLES,
  canAssignRole,
  permissionsForRole,
  roleHasPermission,
  type Permission,
  type Role,
} from './permissions.ts';

/**
 * Explicit expected matrix. If the policy changes, this test must be edited deliberately
 * alongside PERMISSION_CATALOG_VERSION.
 */
const EXPECTED: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter(
    (p) =>
      ![
        'organization.transfer_ownership',
        'organization.delete_request',
        'billing.manage',
      ].includes(p),
  ),
  billing_admin: ['organization.read', 'billing.read', 'billing.manage'],
  event_manager: [
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
  ],
  content_editor: ['organization.read', 'event.read', 'page.edit', 'asset.manage'],
  registration_manager: [
    'organization.read',
    'event.read',
    'registration.manage',
    'registration.export_pii',
    'attendee.checkin',
    'report.read',
  ],
  analyst: ['organization.read', 'event.read', 'report.read'],
  viewer: ['organization.read', 'event.read'],
};

describe('permission catalog', () => {
  it('is versioned', () => {
    expect(PERMISSION_CATALOG_VERSION).toBe(1);
  });

  describe.each(ROLES)('role %s', (role) => {
    it.each(PERMISSIONS)(`grants exactly the expected permission: %s`, (permission) => {
      expect(roleHasPermission(role, permission)).toBe(EXPECTED[role].includes(permission));
    });
  });

  it('keeps PRD restrictions', () => {
    expect(roleHasPermission('content_editor', 'event.publish')).toBe(false);
    expect(roleHasPermission('content_editor', 'registration.export_pii')).toBe(false);
    expect(roleHasPermission('billing_admin', 'registration.export_pii')).toBe(false);
    expect(roleHasPermission('billing_admin', 'membership.manage')).toBe(false);
    expect(roleHasPermission('registration_manager', 'page.edit')).toBe(false);
    expect(roleHasPermission('analyst', 'registration.export_pii')).toBe(false);
    expect(roleHasPermission('event_manager', 'domain.manage')).toBe(false);
    expect(roleHasPermission('event_manager', 'billing.manage')).toBe(false);
    expect(roleHasPermission('admin', 'organization.transfer_ownership')).toBe(false);
  });

  it('denies by default for unknown roles and permissions', () => {
    expect(roleHasPermission('superuser', 'event.read')).toBe(false);
    expect(roleHasPermission('owner', 'event.everything')).toBe(false);
    expect(roleHasPermission(undefined, 'event.read')).toBe(false);
    expect(roleHasPermission('owner', undefined)).toBe(false);
  });

  it('lists permissions per role', () => {
    expect(permissionsForRole('viewer')).toEqual(['organization.read', 'event.read']);
  });
});

describe('canAssignRole', () => {
  it('lets owners grant any role, including owner', () => {
    for (const r of ROLES) expect(canAssignRole('owner', r)).toBe(true);
  });

  it('prevents admins from granting owner but allows lower roles', () => {
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'viewer')).toBe(true);
  });

  it('denies roles without membership.manage', () => {
    for (const r of ROLES.filter((x) => x !== 'owner' && x !== 'admin')) {
      expect(canAssignRole(r, 'viewer')).toBe(false);
    }
  });

  it('denies unknown roles', () => {
    expect(canAssignRole('owner', 'root')).toBe(false);
  });
});
