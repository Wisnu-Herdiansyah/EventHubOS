import { describe, expect, it } from 'vitest';
import { auditQuery } from './modules/audit/routes.ts';

describe('audit query validation', () => {
  it('applies defaults and accepts valid filters', () => {
    expect(auditQuery.parse({})).toEqual({ limit: 50 });
    const q = auditQuery.parse({
      limit: '10',
      actionPrefix: 'membership.',
      targetType: 'event',
      targetId: '3f1c1f0e-2a7b-4c3d-8e9f-0a1b2c3d4e5f',
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    });
    expect(q.limit).toBe(10);
  });

  it('rejects malformed or contradictory filters', () => {
    for (const bad of [
      { action: 'membership.' }, // a category is not a full action
      { actionPrefix: 'membership' }, // a category must end with a dot
      { action: 'event.created', actionPrefix: 'event.' },
      { targetId: '3f1c1f0e-2a7b-4c3d-8e9f-0a1b2c3d4e5f' }, // needs targetType
      { targetType: 'app_user' }, // not a tenant object type
      { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      { limit: '0' },
      { limit: '101' },
      { action: "event.created' OR 1=1" },
      { unknown: 'x' },
    ]) {
      expect(auditQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
