import { describe, expect, it } from 'vitest';
import { registrationStateLabel, seatsLabel } from './registrations';

describe('registration labels', () => {
  it('names each state with a tone', () => {
    expect(registrationStateLabel('open')).toEqual({ label: 'Open', tone: 'success' });
    expect(registrationStateLabel('full')).toEqual({ label: 'Full', tone: 'warning' });
    expect(registrationStateLabel('not_open_yet').label).toBe('Not open yet');
    expect(registrationStateLabel('closed').label).toBe('Closed');
    expect(registrationStateLabel('anything').label).toBe('Closed');
  });

  it('shows seats against capacity when there is one', () => {
    expect(seatsLabel(12, 100)).toBe('12 of 100');
    expect(seatsLabel(12, null)).toBe('12');
  });
});
