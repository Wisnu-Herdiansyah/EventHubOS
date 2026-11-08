import { describe, expect, it } from 'vitest';
import { eventDateLine } from './format';

describe('eventDateLine', () => {
  it('shows the start in the event time zone with its offset', () => {
    expect(eventDateLine('2027-03-01T02:00:00Z', 'Asia/Jakarta')).toBe('1 Mar 2027, 09:00 GMT+7');
    expect(eventDateLine('2027-03-01T02:00:00Z', 'UTC')).toBe('1 Mar 2027, 02:00 GMT+0');
  });
});
