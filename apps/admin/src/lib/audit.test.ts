import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  auditHref,
  auditQuery,
  describeAuditEvent,
  parseAuditFilters,
  type AuditRecord,
} from './audit';

const names = {
  members: new Map([['11111111-1111-4111-8111-111111111111', 'ade@example.test']]),
  events: new Map([['22222222-2222-4222-8222-222222222222', 'Jakarta Summit']]),
};
const record = (
  action: string,
  metadata: Record<string, unknown>,
  targetId: string | null = null,
) =>
  ({
    action,
    metadata,
    targetId,
    targetType: 'x',
    actor: { type: 'user', id: null, email: 'owner@example.test' },
  }) satisfies AuditRecord;

describe('describeAuditEvent', () => {
  it('describes registrations without personal data', () => {
    const ev = '22222222-2222-4222-8222-222222222222';
    expect(
      describeAuditEvent(
        record('registration.created', { eventId: ev, source: 'public_site' }),
        names,
      ).summary,
    ).toBe('Someone registered for Jakarta Summit on its public page');
    expect(
      describeAuditEvent(record('registration.cancelled', { eventId: ev, by: 'attendee' }), names)
        .summary,
    ).toBe('An attendee cancelled their registration for Jakarta Summit');
    expect(
      describeAuditEvent(record('registration.cancelled', { eventId: ev, by: 'organizer' }), names)
        .summary,
    ).toBe('Cancelled a registration for Jakarta Summit');
  });

  it('describes microsite drafts and publications by version, never by content', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(
      describeAuditEvent(
        record('event.page_draft_saved', { draftVersion: 3, sectionCount: 5 }, id),
        names,
      ),
    ).toEqual({
      summary: 'Saved the microsite draft of Jakarta Summit',
      details: ['Draft version 3.'],
    });
    expect(describeAuditEvent(record('event.page_published', { revision: 2 }, id), names)).toEqual({
      summary: 'Published the microsite of Jakarta Summit',
      details: ['Revision 2.'],
    });
  });

  it('describes team changes with names and roles', () => {
    expect(
      describeAuditEvent(
        record(
          'membership.role_changed',
          { from: 'event_manager', to: 'viewer', revokedInvitations: 2 },
          '11111111-1111-4111-8111-111111111111',
        ),
        names,
      ),
    ).toEqual({
      summary: 'Changed the role of ade@example.test from Event manager to Viewer',
      details: ['2 pending invitations were revoked with it.'],
    });
    expect(describeAuditEvent(record('membership.removed', { self: true }), names).summary).toBe(
      'Left the organization',
    );
    expect(
      describeAuditEvent(record('membership.removed', { role: 'viewer' }, 'unknown'), names)
        .summary,
    ).toBe('Removed a former member (Viewer)');
    expect(
      describeAuditEvent(
        record('membership.invited', { role: 'admin', email: 'a***@example.test' }),
        names,
      ).summary,
    ).toBe('Invited a***@example.test as Admin');
  });

  it('describes events and settings in words, not field names', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(
      describeAuditEvent(
        record(
          'event.lifecycle_changed',
          { from: 'draft', to: 'scheduled', acknowledgedWarnings: ['a', 'b'] },
          id,
        ),
        names,
      ),
    ).toEqual({
      summary: 'Moved Jakarta Summit from Draft to Scheduled',
      details: ['Acknowledged 2 skipped recommendations.'],
    });
    expect(
      describeAuditEvent(record('event.updated', { fields: ['name', 'settings.legal'] }, id), names)
        .summary,
    ).toBe('Changed the name and legal links of Jakarta Summit');
    expect(
      describeAuditEvent(
        record('organization.updated', { fields: ['displayName', 'timezone', 'billingContact'] }),
        names,
      ).summary,
    ).toBe("Changed the organization's name, time zone and billing contact");
  });

  it('describes the two-step verification requirement in words', () => {
    const on = record('organization.updated', {
      fields: ['requireMfaForAdmins'],
      requireMfaForAdmins: true,
    });
    expect(describeAuditEvent(on, names)).toEqual({
      summary: 'Required two-step verification for Owners and Admins',
      details: [],
    });
    const offWithName = record('organization.updated', {
      fields: ['displayName', 'requireMfaForAdmins'],
      requireMfaForAdmins: false,
    });
    expect(describeAuditEvent(offWithName, names)).toEqual({
      summary: "Changed the organization's name",
      details: ['Stopped requiring two-step verification for Owners and Admins.'],
    });
    // A non-boolean value is not trusted.
    const odd = record('organization.updated', {
      fields: ['publicHandle'],
      requireMfaForAdmins: 'yes',
    });
    expect(describeAuditEvent(odd, names).summary).toBe(
      "Changed the organization's public address",
    );
  });

  it('falls back to the action name for unknown actions and never trusts metadata types', () => {
    expect(describeAuditEvent(record('future.thing', {}), names).summary).toBe('future.thing');
    expect(
      describeAuditEvent(record('membership.role_changed', { from: 42, to: { x: 1 } }), names)
        .summary,
    ).toBe('Changed the role of a former member from a role to a role');
  });

  it('labels actors without an email', () => {
    expect(actorLabel({ type: 'system', id: null, email: null })).toBe('System');
    expect(actorLabel({ type: 'user', id: 'x', email: null })).toBe('A former member');
  });
});

describe('audit filters', () => {
  const actor = '11111111-1111-4111-8111-111111111111';

  it('keeps well-formed filters and drops the rest', () => {
    expect(
      parseAuditFilters({
        category: 'membership.',
        actorId: actor,
        from: '2027-03-01',
        to: '2027-03-02',
      }),
    ).toEqual({
      filters: {
        category: 'membership.',
        actorId: actor,
        fromDate: '2027-03-01',
        toDate: '2027-03-02',
      },
      ignored: false,
    });
    expect(
      parseAuditFilters({
        category: 'identity.',
        actorId: "1' OR 1=1",
        from: '2027-02-31',
        targetType: 'user',
        targetId: actor,
        cursor: '../../etc',
      }),
    ).toEqual({ filters: {}, ignored: true });
    expect(parseAuditFilters({ from: '2027-03-05', to: '2027-03-01' })).toEqual({
      filters: { fromDate: '2027-03-05' },
      ignored: true,
    });
  });

  it('turns whole days in the organization time zone into a half-open UTC range', () => {
    expect(auditQuery({ fromDate: '2027-03-01', toDate: '2027-03-01' }, 'Asia/Jakarta')).toEqual({
      limit: 50,
      from: '2027-02-28T17:00:00.000Z',
      to: '2027-03-01T17:00:00.000Z',
    });
  });

  it('builds links that keep filters', () => {
    expect(auditHref('o', { targetType: 'event', targetId: actor, cursor: 'abc' })).toBe(
      `/orgs/o/audit?targetType=event&targetId=${actor}&cursor=abc`,
    );
    expect(auditHref('o', {})).toBe('/orgs/o/audit');
  });
});
