import { describe, expect, it } from 'vitest';
import {
  bulkDecisionNotice,
  parseAttendeeSearch,
  registrationStateLabel,
  registrationsHref,
  searchResultLabel,
  seatsLabel,
} from './registrations';

describe('registration labels', () => {
  it('names each state with a tone', () => {
    expect(registrationStateLabel('open')).toEqual({ label: 'Open', tone: 'success' });
    expect(registrationStateLabel('cancelled')).toEqual({
      label: 'Closed: event cancelled',
      tone: 'danger',
    });
    expect(registrationStateLabel('full')).toEqual({ label: 'Full', tone: 'warning' });
    expect(registrationStateLabel('not_open_yet').label).toBe('Not open yet');
    expect(registrationStateLabel('closed').label).toBe('Closed');
    expect(registrationStateLabel('anything').label).toBe('Closed');
  });

  it('says when a full event is still taking a waitlist (ADR-0035)', () => {
    expect(registrationStateLabel('full', true)).toEqual({
      label: 'Full, waitlist open',
      tone: 'warning',
    });
    expect(registrationStateLabel('open', true).label).toBe('Open');
    expect(registrationStateLabel('full', false).label).toBe('Full');
  });

  it('shows seats against capacity when there is one', () => {
    expect(seatsLabel(12, 100)).toBe('12 of 100');
    expect(seatsLabel(12, null)).toBe('12');
  });
});

describe('bulkDecisionNotice (ADR-0066)', () => {
  it('counts the decided requests, singular and plural', () => {
    expect(bulkDecisionNotice('approve', 1, 0)).toBe(
      '1 request approved. Each person is registered and has been emailed their ticket.',
    );
    expect(bulkDecisionNotice('decline', 4, 0)).toBe(
      '4 requests declined. Each person has been told by email.',
    );
  });
  it('says how many had already been dealt with', () => {
    expect(bulkDecisionNotice('approve', 2, 1)).toBe(
      '2 requests approved. Each person is registered and has been emailed their ticket. 1 was already dealt with and left as is.',
    );
    expect(bulkDecisionNotice('decline', 1, 3)).toBe(
      '1 request declined. Each person has been told by email. 3 were already dealt with and left as is.',
    );
  });
  it('says nothing changed when none were decided', () => {
    for (const d of ['approve', 'decline'] as const) {
      expect(bulkDecisionNotice(d, 0, 2)).toBe(
        'Nothing changed: the selected requests had already been dealt with.',
      );
    }
  });
});

describe('attendee search (ADR-0069)', () => {
  it('keeps a trimmed one-line search of up to 100 characters', () => {
    expect(parseAttendeeSearch('  ade  ')).toBe('ade');
    expect(parseAttendeeSearch(['first', 'second'])).toBe('first');
    expect(parseAttendeeSearch('x'.repeat(100))).toBe('x'.repeat(100));
  });
  it('drops what the API would refuse', () => {
    for (const bad of [
      undefined,
      '',
      '   ',
      'x'.repeat(101),
      'two\nlines',
      'tab\there',
      'nul\u0000',
    ]) {
      expect(parseAttendeeSearch(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
  it('links keep the filter and the search together', () => {
    const base = '/orgs/o/events/e/registrations';
    expect(registrationsHref(base, {})).toBe(base);
    expect(registrationsHref(base, { status: 'pending' })).toBe(`${base}?status=pending`);
    expect(registrationsHref(base, { q: 'ade' })).toBe(`${base}?q=ade`);
    expect(registrationsHref(base, { status: 'confirmed', q: 'a&b c' })).toBe(
      `${base}?status=confirmed&q=a%26b+c`,
    );
  });
  it('counts what was found', () => {
    expect(searchResultLabel(1, 'ade', false)).toBe('1 person matches “ade”.');
    expect(searchResultLabel(3, 'ade', false)).toBe('3 people match “ade”.');
    expect(searchResultLabel(1000, 'a', true)).toBe('1000 or more people match “a”.');
  });
});
