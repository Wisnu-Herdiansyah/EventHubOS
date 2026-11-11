import { describe, expect, it } from 'vitest';
import { attendanceRate, checkInRows, monthLabel, signUpRows, viewRows } from './report';

const day = (i: number, registered = 1) => {
  const d = new Date(Date.UTC(2027, 1, 1 + i));
  return { date: d.toISOString().slice(0, 10), registered };
};

describe('event report shaping (ADR-0030)', () => {
  it('lists days up to a month, then sums by week', () => {
    expect(signUpRows([day(0, 3), day(1, 0)])).toEqual([
      { label: '1 Feb', value: 3 },
      { label: '2 Feb', value: 0 },
    ]);
    const weekly = signUpRows(Array.from({ length: 40 }, (_, i) => day(i)));
    expect(weekly).toHaveLength(6);
    expect(weekly[0]).toEqual({ label: '1 Feb – 7 Feb', value: 7 });
    expect(weekly.at(-1)).toEqual({ label: '8 Mar – 12 Mar', value: 5 });
    expect(weekly.reduce((n, r) => n + r.value, 0)).toBe(40);
  });

  it('shapes page views the same way (ADR-0044)', () => {
    expect(viewRows([{ date: '2027-02-01', views: 12 }])).toEqual([{ label: '1 Feb', value: 12 }]);
    const weekly = viewRows(
      Array.from({ length: 35 }, (_, i) => ({ date: day(i).date, views: 2 })),
    );
    expect(weekly).toHaveLength(5);
    expect(weekly[0]).toEqual({ label: '1 Feb – 7 Feb', value: 14 });
  });

  it('labels check-in hours, with the day only when they span days', () => {
    expect(
      checkInRows([
        { hour: '2027-03-01T09:00', checkedIn: 2 },
        { hour: '2027-03-01T10:00', checkedIn: 1 },
      ]),
    ).toEqual([
      { label: '09:00', value: 2 },
      { label: '10:00', value: 1 },
    ]);
    expect(
      checkInRows([
        { hour: '2027-03-01T09:00', checkedIn: 2 },
        { hour: '2027-03-02T09:00', checkedIn: 4 },
      ]).map((r) => r.label),
    ).toEqual(['1 Mar 09:00', '2 Mar 09:00']);
  });

  it('labels months', () => {
    expect(monthLabel('2027-03')).toBe('Mar 2027');
    expect(monthLabel('2026-12')).toBe('Dec 2026');
  });

  it('gives the attendance rate, or nothing without registrations', () => {
    expect(attendanceRate(3, 2)).toBe(67);
    expect(attendanceRate(0, 0)).toBeNull();
  });
});
