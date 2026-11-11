import { describe, expect, it } from 'vitest';
import { barPercent } from '../components/ui/chart';
import {
  adminsWithoutTwoStep,
  invitationStatus,
  lifecycleCounts,
  lifecycleStatus,
  remindedRecently,
  twoStepStatus,
} from './status';

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

describe('two-step verification on the Team page (ADR-0025)', () => {
  it('marks Owners and Admins held out by the requirement', () => {
    expect(twoStepStatus(true, 'owner', true)).toEqual({ label: 'On', tone: 'success' });
    expect(twoStepStatus(false, 'admin', true)).toEqual({ label: 'Needed', tone: 'danger' });
    expect(twoStepStatus(false, 'owner', false)).toEqual({ label: 'Off', tone: 'neutral' });
    expect(twoStepStatus(false, 'viewer', true)).toEqual({ label: 'Off', tone: 'neutral' });
  });
  it('counts only Owners and Admins known to be without it', () => {
    const list = [
      { role: 'owner', twoStepEnabled: true },
      { role: 'admin', twoStepEnabled: false },
      { role: 'owner', twoStepEnabled: false },
      { role: 'viewer', twoStepEnabled: false },
      { role: 'admin' },
    ];
    expect(adminsWithoutTwoStep(list)).toEqual([list[1], list[2]]);
  });
});

describe('two-step reminders (ADR-0031)', () => {
  it('counts a reminder as recent for 24 hours', () => {
    const now = new Date('2027-03-02T12:00:00Z');
    expect(remindedRecently(null, now)).toBe(false);
    expect(remindedRecently('2027-03-02T00:00:00Z', now)).toBe(true);
    expect(remindedRecently('2027-03-01T12:00:01Z', now)).toBe(true);
    expect(remindedRecently('2027-03-01T11:59:59Z', now)).toBe(false);
  });
});
