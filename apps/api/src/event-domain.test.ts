import { describe, expect, it } from 'vitest';
import { buildChecklist, evaluateForScheduling } from './modules/event/checklist.ts';
import { availableTransitions, checkTransition, TRANSITIONS } from './modules/event/lifecycle.ts';
import {
  applySettingsPatch,
  eventSettingsSchema,
  settingsIssues,
} from './modules/event/settings.ts';

const day = 86_400_000;
const schedule = {
  startsAt: new Date('2027-05-10T02:00:00Z'),
  endsAt: new Date('2027-05-10T11:00:00Z'),
};

describe('event settings', () => {
  it('accepts a complete, valid configuration', () => {
    expect(
      eventSettingsSchema.safeParse({
        visibility: 'public',
        registration: {
          opensAt: '2027-04-01T00:00:00+07:00',
          closesAt: '2027-05-09T00:00:00+07:00',
          capacity: 500,
        },
        sharing: { title: 'Jakarta Summit', description: 'A day of talks.' },
        contact: {
          email: 'hello@example.com',
          phone: '+6281234567890',
          url: 'https://example.com/contact',
        },
        legal: {
          privacyPolicyUrl: 'https://example.com/privacy',
          termsUrl: 'https://example.com/terms',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects unsafe or malformed values', () => {
    for (const bad of [
      { legal: { privacyPolicyUrl: 'http://example.com/privacy' } }, // not HTTPS
      { legal: { privacyPolicyUrl: 'javascript:alert(1)' } },
      { contact: { phone: '0812345' } },
      { registration: { capacity: 0 } },
      { sharing: { title: 'x'.repeat(71) } },
      { theme: 'neon' }, // unknown section
      { contact: { email: 'a@b.co', fax: '1' } }, // unknown field
    ]) {
      expect(eventSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('patch replaces provided sections and clears null ones', () => {
    const current = {
      visibility: 'public' as const,
      contact: { email: 'a@example.com' },
      legal: { termsUrl: 'https://e.com/t' },
    };
    const next = applySettingsPatch(current, { contact: { url: 'https://e.com/c' }, legal: null });
    expect(next).toEqual({ visibility: 'public', contact: { url: 'https://e.com/c' } });
  });

  it('flags incoherent registration windows against the event schedule', () => {
    const issues = (registration: object) =>
      settingsIssues({ registration }, schedule).map((i) => i.path);
    expect(issues({ opensAt: '2027-05-01T00:00:00Z', closesAt: '2027-04-01T00:00:00Z' })).toContain(
      'body.settings.registration.closesAt',
    );
    expect(issues({ opensAt: '2027-05-11T00:00:00Z' })).toContain(
      'body.settings.registration.opensAt',
    );
    expect(issues({ closesAt: '2027-05-12T00:00:00Z' })).toContain(
      'body.settings.registration.closesAt',
    );
    expect(issues({ opensAt: '2027-04-01T00:00:00Z', closesAt: '2027-05-10T01:00:00Z' })).toEqual(
      [],
    );
  });
});

describe('lifecycle transitions', () => {
  it('allows only named transitions', () => {
    expect(checkTransition('draft', 'scheduled', null).ok).toBe(true);
    expect(checkTransition('draft', 'ended', null)).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
    expect(checkTransition('ended', 'draft', null)).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
  });

  it('refuses publishing transitions until published revisions exist', () => {
    expect(checkTransition('scheduled', 'published', null)).toEqual({
      ok: false,
      reason: 'requires_published_revision',
    });
  });

  it('restores an archived event only to where it came from', () => {
    expect(checkTransition('archived', 'draft', 'draft').ok).toBe(true);
    expect(checkTransition('archived', 'draft', 'scheduled').ok).toBe(true); // checklist must re-run
    expect(checkTransition('archived', 'ended', 'ended').ok).toBe(true);
    expect(checkTransition('archived', 'ended', 'draft')).toEqual({
      ok: false,
      reason: 'restore_target_mismatch',
    });
    expect(checkTransition('archived', 'draft', 'ended')).toEqual({
      ok: false,
      reason: 'restore_target_mismatch',
    });
  });

  it('lists available targets and gates every rule by an explicit permission', () => {
    expect(availableTransitions('draft', null).sort()).toEqual(['archived', 'scheduled']);
    expect(availableTransitions('scheduled', null).sort()).toEqual(['archived', 'draft']);
    expect(availableTransitions('archived', 'ended')).toEqual(['ended']);
    for (const t of TRANSITIONS) expect(['event.publish', 'event.archive']).toContain(t.permission);
  });
});

describe('setup checklist', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const ready = {
    visibility: 'public' as const,
    sharing: { title: 'T', description: 'D' },
    legal: { privacyPolicyUrl: 'https://e.com/p', termsUrl: 'https://e.com/t' },
    contact: { email: 'a@e.com' },
    registration: { opensAt: '2026-12-01T00:00:00Z', closesAt: '2027-05-01T00:00:00Z' },
  };

  it('is complete for a fully configured future event', () => {
    const items = buildChecklist({
      name: 'x',
      startsAt: new Date(now.getTime() + day),
      settings: ready,
      now,
    });
    expect(items.every((i) => i.complete)).toBe(true);
    expect(evaluateForScheduling(items, [])).toEqual({
      blockingIncomplete: [],
      unacknowledgedWarnings: [],
    });
  });

  it('blocks on past start, missing sharing metadata, and missing privacy policy', () => {
    const items = buildChecklist({
      name: 'x',
      startsAt: new Date(now.getTime() - day),
      settings: {},
      now,
    });
    expect(evaluateForScheduling(items, []).blockingIncomplete).toEqual([
      'schedule.starts_in_future',
      'sharing.metadata',
      'legal.privacy_policy',
    ]);
  });

  it('does not require sharing metadata for private events', () => {
    const items = buildChecklist({
      name: 'x',
      startsAt: new Date(now.getTime() + day),
      settings: { visibility: 'private' },
      now,
    });
    expect(items.find((i) => i.id === 'sharing.metadata')?.complete).toBe(true);
  });

  it('requires each incomplete recommendation to be acknowledged', () => {
    const settings = { sharing: ready.sharing, legal: { privacyPolicyUrl: 'https://e.com/p' } };
    const items = buildChecklist({
      name: 'x',
      startsAt: new Date(now.getTime() + day),
      settings,
      now,
    });
    expect(evaluateForScheduling(items, []).unacknowledgedWarnings).toEqual([
      'contact.details',
      'registration.window',
      'legal.terms',
    ]);
    expect(
      evaluateForScheduling(items, ['contact.details', 'registration.window'])
        .unacknowledgedWarnings,
    ).toEqual(['legal.terms']);
    expect(
      evaluateForScheduling(items, ['contact.details', 'registration.window', 'legal.terms'])
        .unacknowledgedWarnings,
    ).toEqual([]);
  });
});
