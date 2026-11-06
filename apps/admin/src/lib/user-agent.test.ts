import { describe, expect, it } from 'vitest';
import { relativeTime } from './time';
import { describeUserAgent } from './user-agent';

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
      'Firefox on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      'Safari on iPhone',
    ],
    [
      'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['curl/8.11.0', 'Unknown browser'],
    [null, 'Unknown browser'],
  ])('%s → %s', (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });
});

describe('relativeTime', () => {
  const now = new Date('2027-03-01T12:00:00Z');
  it.each([
    ['2027-03-01T11:59:30Z', 'just now'],
    ['2027-03-01T11:59:00Z', '1 minute ago'],
    ['2027-03-01T11:48:00Z', '12 minutes ago'],
    ['2027-03-01T09:00:00Z', '3 hours ago'],
    ['2027-02-27T12:00:00Z', '2 days ago'],
    ['2027-03-01T12:05:00Z', 'just now'],
  ])('%s → %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});
