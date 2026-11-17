import { describe, expect, it } from 'vitest';
import { bulkDecisionNotice, registrationStateLabel, seatsLabel } from './registrations';

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
