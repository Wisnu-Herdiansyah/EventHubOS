import { describe, expect, it } from 'vitest';
import { barPercent } from '../components/ui/chart';
import { invitationStatus, lifecycleCounts, lifecycleStatus } from './status';

describe('status tones', () => {
  it('gives every lifecycle state a label and a tone', () => {
    expect(lifecycleStatus('draft')).toEqual({ label: 'Draft', tone: 'neutral' });
    expect(lifecycleStatus('scheduled')).toEqual({ label: 'Scheduled', tone: 'accent' });
    expect(lifecycleStatus('archived')).toEqual({ label: 'Archived', tone: 'warning' });
    expect(lifecycleStatus('mystery')).toEqual({ label: 'mystery', tone: 'neutral' });
  });

  it('maps invitation states', () => {
    expect(invitationStatus('pending').tone).toBe('warning');
    expect(invitationStatus('accepted')).toEqual({ label: 'Accepted', tone: 'success' });
    expect(invitationStatus('other')).toEqual({ label: 'other', tone: 'neutral' });
  });
});

describe('lifecycleCounts', () => {
  it('counts in lifecycle order and always shows Draft', () => {
    expect(lifecycleCounts([])).toEqual([{ lifecycle: 'draft', label: 'Draft', count: 0 }]);
    expect(
      lifecycleCounts([
        { lifecycle: 'archived' },
        { lifecycle: 'draft' },
        { lifecycle: 'scheduled' },
        { lifecycle: 'draft' },
        { lifecycle: 'zeta' },
      ]).map((r) => [r.lifecycle, r.count]),
    ).toEqual([
      ['draft', 2],
      ['scheduled', 1],
      ['archived', 1],
      ['zeta', 1],
    ]);
  });
});

describe('barPercent', () => {
  it('scales to the largest value with a visible minimum', () => {
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(10, 10)).toBe(100);
    expect(barPercent(0.01, 10)).toBe(2);
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(3, 0)).toBe(0);
    expect(barPercent(Number.NaN, 10)).toBe(0);
  });
});
