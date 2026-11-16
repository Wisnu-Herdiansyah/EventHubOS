import { describe, expect, it } from 'vitest';
import {
  attendanceRate,
  checkInRows,
  monthLabel,
  ratingRows,
  responseRate,
  signUpRows,
  viewRows,
} from './report';

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

describe('feedback figures (ADR-0063)', () => {
  it('lists ratings best first, with a row for each of the five', () => {
    expect(ratingRows([0, 1, 0, 2, 1])).toEqual([
      { label: '5 – Excellent', value: 1 },
      { label: '4 – Good', value: 2 },
      { label: '3 – OK', value: 0 },
      { label: '2 – Poor', value: 1 },
      { label: '1 – Very poor', value: 0 },
    ]);
    expect(ratingRows([]).map((r) => r.value)).toEqual([0, 0, 0, 0, 0]);
  });

  it('says how many answered, and does not divide by zero', () => {
    expect(responseRate(12, 3)).toBe('3 of 12 answered (25%)');
    expect(responseRate(3, 3)).toBe('3 of 3 answered (100%)');
    expect(responseRate(3, 1)).toBe('1 of 3 answered (33%)');
    expect(responseRate(0, 0)).toBe('Nobody has been asked yet');
  });
});
