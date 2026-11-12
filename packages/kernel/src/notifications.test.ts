import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MANDATORY_NOTICES,
  NOTIFICATIONS,
  NOTIFICATION_KINDS,
  mandatoryNoticesFor,
  notificationsFor,
} from './notifications.ts';
import { ROLES } from './permissions.ts';

describe('notification catalog (ADR-0049)', () => {
  it('offers the download alert to Owners and Admins only', () => {
    for (const role of ROLES) {
      expect(notificationsFor(role), role).toEqual(
        role === 'owner' || role === 'admin' ? ['data_download'] : [],
      );
    }
    expect(notificationsFor('support')).toEqual([]);
    expect(notificationsFor('nobody')).toEqual([]);
  });

  it('lists the security notices each role gets regardless of settings', () => {
    expect(mandatoryNoticesFor('owner')).toEqual([...MANDATORY_NOTICES]);
    expect(mandatoryNoticesFor('admin')).toEqual(['two_step_reminder']);
    expect(mandatoryNoticesFor('viewer')).toEqual([]);
    expect(mandatoryNoticesFor('support')).toEqual([]);
  });

  it('keeps optional and mandatory notices apart', () => {
    for (const k of NOTIFICATION_KINDS) {
      expect((MANDATORY_NOTICES as readonly string[]).includes(k)).toBe(false);
    }
  });

  it('matches the roles, default and kinds the database applies (migration 0031)', () => {
    const sql = readFileSync(
      join(import.meta.dirname, '../../db/migrations/0031_notification_settings.sql'),
      'utf8',
    );
    const kinds = /kind IN \(([^)]*)\)/
      .exec(sql)![1]!
      .match(/'([a-z_]+)'/g)!
      .map((s) => s.slice(1, -1));
    expect(kinds).toEqual([...NOTIFICATION_KINDS]);
    const roles = /m\.role IN \(([^)]*)\)/
      .exec(sql)![1]!
      .match(/'([a-z_]+)'/g)!
      .map((s) => s.slice(1, -1));
    expect(roles).toEqual([...NOTIFICATIONS.data_download.roles]);
    expect(sql).toContain(
      `coalesce(np.enabled, ${String(NOTIFICATIONS.data_download.defaultEnabled)})`,
    );
  });
});
