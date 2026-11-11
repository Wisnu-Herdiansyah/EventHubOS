import { describe, expect, it } from 'vitest';
import {
  isCalendarDay,
  monthsFootnote,
  periodLabel,
  periodSearch,
  reportCsv,
  reportFilename,
  resolvePeriod,
  todayIn,
} from './report-period';

const TODAY = '2026-11-11';

describe('report periods', () => {
  it('resolves the presets from today in the organization time zone', () => {
    expect(resolvePeriod({}, TODAY)).toEqual({ period: { key: 'all' }, invalid: false });
    expect(resolvePeriod({ period: 'all' }, TODAY).period).toEqual({ key: 'all' });
    expect(resolvePeriod({ period: '30d' }, TODAY).period).toEqual({
      key: '30d',
      from: '2026-10-13',
      to: '2026-11-11',
    });
    expect(resolvePeriod({ period: 'year' }, TODAY).period).toEqual({
      key: 'year',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(resolvePeriod({ period: 'last-year' }, TODAY).period).toEqual({
      key: 'last-year',
      from: '2025-01-01',
      to: '2025-12-31',
    });
    // Across a month and a leap day.
    expect(resolvePeriod({ period: '30d' }, '2028-03-01').period.from).toBe('2028-02-01');
    expect(resolvePeriod({ period: '30d' }, '2027-03-01').period.from).toBe('2027-01-31');
  });

  it('accepts a valid custom range, including a single day', () => {
    expect(
      resolvePeriod({ period: 'custom', from: '2026-03-01', to: '2026-03-31' }, TODAY),
    ).toEqual({ period: { key: 'custom', from: '2026-03-01', to: '2026-03-31' }, invalid: false });
    expect(
      resolvePeriod({ period: 'custom', from: '2026-03-01', to: '2026-03-01' }, TODAY).invalid,
    ).toBe(false);
    // Repeated parameters use the first value.
    expect(
      resolvePeriod({ period: ['custom', 'all'], from: ['2026-01-01'], to: '2026-01-02' }, TODAY)
        .period.key,
    ).toBe('custom');
  });

  it('falls back to all time for anything else', () => {
    for (const search of [
      { period: 'forever' },
      { period: 'custom' },
      { period: 'custom', from: '2026-03-01' },
      { period: 'custom', from: '2026-03-31', to: '2026-03-01' },
      { period: 'custom', from: '2026-02-30', to: '2026-03-01' },
      { period: 'custom', from: '1999-12-31', to: '2000-01-01' },
      { period: 'custom', from: '2026-3-1', to: '2026-03-02' },
      { period: 'custom', from: '2026-03-01&x=1', to: '2026-03-02' },
    ]) {
      expect(resolvePeriod(search, TODAY), JSON.stringify(search)).toEqual({
        period: { key: 'all' },
        invalid: true,
      });
    }
  });

  it('checks calendar days', () => {
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2027-02-29')).toBe(false);
    expect(isCalendarDay('2099-12-31')).toBe(true);
    expect(isCalendarDay('2100-01-01')).toBe(false);
    expect(isCalendarDay(undefined)).toBe(false);
  });

  it('builds links, labels and file names', () => {
    expect(periodSearch({ key: 'all' })).toBe('');
    expect(periodSearch({ key: 'year', from: '2026-01-01', to: '2026-12-31' })).toBe(
      '?period=year',
    );
    expect(periodSearch({ key: 'custom', from: '2026-03-01', to: '2026-03-31' })).toBe(
      '?period=custom&from=2026-03-01&to=2026-03-31',
    );
    expect(periodLabel({ key: 'all' })).toBe('All time');
    expect(periodLabel({ key: '30d', from: '2026-10-13', to: '2026-11-11' })).toBe(
      'Last 30 days (13 Oct 2026 – 11 Nov 2026)',
    );
    expect(periodLabel({ key: 'custom', from: '2026-03-05', to: '2026-03-05' })).toBe('5 Mar 2026');
    expect(reportFilename({ key: 'all' }, TODAY)).toBe('events-report-all-time-2026-11-11.csv');
    expect(reportFilename({ key: 'year', from: '2026-01-01', to: '2026-12-31' }, TODAY)).toBe(
      'events-report-2026-01-01-to-2026-12-31.csv',
    );
  });

  it('finds today in the organization time zone', () => {
    const late = new Date('2026-11-11T18:30:00Z');
    expect(todayIn('UTC', late)).toBe('2026-11-11');
    expect(todayIn('Asia/Jakarta', late)).toBe('2026-11-12');
    expect(todayIn('America/Los_Angeles', new Date('2026-11-11T05:00:00Z'))).toBe('2026-11-10');
  });

  it('describes the chart for the period', () => {
    const months = [{ month: '2025-01', signUps: 1 }];
    expect(
      monthsFootnote({
        period: null,
        signUpsByMonth: months,
        monthsTruncated: false,
        timezone: 'UTC',
      }),
    ).toBe('The last 12 months, in UTC.');
    expect(
      monthsFootnote({
        period: { from: '2020-01-01', to: '2026-12-31' },
        signUpsByMonth: months,
        monthsTruncated: true,
        timezone: 'UTC',
      }),
    ).toBe(
      'Sign-ups made during the period, for any event, in UTC. Showing the latest 1 months, from Jan 2025.',
    );
  });
});

describe('report CSV', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    lifecycle: 'live',
    capacity: null as number | null,
    cancelled: 1,
    pageViews: 42,
  };
  it('writes one row per event with local times and safe cells', () => {
    const csv = reportCsv({
      timezone: 'Asia/Jakarta',
      events: [
        {
          ...row,
          name: '=HYPERLINK("http://evil.example")',
          startsAt: '2026-03-01T16:30:00.000Z',
          ended: true,
          capacity: 100,
          registered: 8,
          checkedIn: 6,
        },
        {
          ...row,
          name: 'Future, "Forum"',
          lifecycle: 'scheduled',
          startsAt: '2027-01-01T02:00:00.000Z',
          ended: false,
          registered: 3,
          checkedIn: 0,
        },
      ],
    });
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Event,Starts,Status,Registered,Capacity,Cancelled,Checked in,Attendance %,Page views',
      `"'=HYPERLINK(""http://evil.example"")",2026-03-01 23:30,Live,8,100,1,6,75,42`,
      '"Future, ""Forum""",2027-01-01 09:00,Scheduled,3,,1,0,,42',
      '',
    ]);
  });
});
