import { describe, expect, it } from 'vitest';
import { auditCsv, auditFilename } from './audit-export';

const names = { members: new Map<string, string>(), events: new Map([['e1', 'Jakarta Summit']]) };
const base = {
  id: '00000000-0000-4000-8000-000000000001',
  correlationId: 'req-1',
  targetType: 'event',
  targetId: 'e1',
  metadata: {},
};

describe('audit log CSV (ADR-0047)', () => {
  it('writes local times, plain summaries, raw fields and safe cells', () => {
    const csv = auditCsv(
      {
        generatedAt: '2027-03-01T00:30:00.000Z',
        timezone: 'Asia/Jakarta',
        truncated: false,
        data: [
          {
            ...base,
            occurredAt: '2027-02-28T18:00:00.000Z',
            actor: { type: 'user', id: 'u1', email: '=cmd@example.test' },
            action: 'event.created',
            metadata: { slug: 'jakarta-summit' },
          },
          {
            ...base,
            occurredAt: '2027-02-28T17:00:00.000Z',
            actor: { type: 'platform_support', id: 'u2', email: null },
            action: 'support.accessed',
            targetType: 'organization',
            targetId: null,
            metadata: { permission: 'event.read' },
          },
        ],
      },
      names,
    );
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'When (Asia/Jakarta),Who,What,Details,Action,Object type,Object ID,Data,Reference',
    );
    expect(lines[1]).toBe(
      `2027-03-01 01:00,'=cmd@example.test,Created the event Jakarta Summit,URL slug: jakarta-summit,event.created,event,e1,"{""slug"":""jakarta-summit""}",req-1`,
    );
    expect(lines[2]).toMatch(
      /^2027-03-01 00:00,EventHub support,.*,support\.accessed,organization,,/,
    );
  });

  it('names the file by the day in the organization’s time zone', () => {
    expect(auditFilename({ generatedAt: '2027-02-28T18:30:00Z', timezone: 'Asia/Jakarta' })).toBe(
      'audit-log-2027-03-01.csv',
    );
  });
});

describe('plain descriptions of newer actions', async () => {
  const { describeAuditEvent } = await import('./audit');
  const d = (action: string, metadata: Record<string, unknown> = {}) =>
    describeAuditEvent(
      {
        action,
        targetType: 'organization',
        targetId: null,
        actor: { type: 'user', id: null, email: null },
        metadata,
      },
      names,
    );

  it('describes support access, exports and images', () => {
    expect(
      d('organization.support_access_granted', { expiresAt: '2027-03-01T10:00:00.000Z' }),
    ).toEqual({
      summary: 'Let EventHub support view the organization',
      details: ['Until 2027-03-01 10:00 UTC'],
    });
    expect(d('support.accessed', { permission: 'event.read' }).details).toEqual([
      'Using event.read',
    ]);
    expect(d('audit.exported', { count: 1, filters: [] }).details).toEqual(['1 entry, no filters']);
    expect(d('audit.exported', { count: 12, filters: ['actorId', 'from'] }).details).toEqual([
      '12 entries, filtered by actorId, from',
    ]);
    expect(d('asset.deleted').summary).toBe('Deleted an image');
    expect(d('something.new').summary).toBe('something.new');
  });
});
