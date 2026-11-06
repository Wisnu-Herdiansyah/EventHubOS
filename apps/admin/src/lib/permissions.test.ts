import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { can, canManageMember, teamAbilities } = await import('./permissions');

describe('team abilities (from the shared permission catalog)', () => {
  it('lets Owners grant every role, including Owner', () => {
    const owner = teamAbilities('owner');
    expect(owner).toMatchObject({ canRead: true, canManage: true });
    expect(owner.assignableRoles[0]).toBe('owner');
    expect(owner.assignableRoles).toHaveLength(8);
  });

  it('lets Admins grant Admin and below, never Owner', () => {
    const admin = teamAbilities('admin');
    expect(admin.canManage).toBe(true);
    expect(admin.assignableRoles).not.toContain('owner');
    expect(admin.assignableRoles).toContain('admin');
    expect(canManageMember('admin', 'owner')).toBe(false);
    expect(canManageMember('admin', 'viewer')).toBe(true);
  });

  it('gives other roles no team access at all', () => {
    for (const role of ['billing_admin', 'event_manager', 'viewer', 'nonsense']) {
      expect(teamAbilities(role)).toEqual({
        canRead: false,
        canManage: false,
        assignableRoles: [],
      });
    }
  });

  it('answers event permissions the same way the API does', () => {
    expect(can('event_manager', 'event.create')).toBe(true);
    expect(can('viewer', 'event.create')).toBe(false);
    expect(can('content_editor', 'event.update')).toBe(false);
  });
});
