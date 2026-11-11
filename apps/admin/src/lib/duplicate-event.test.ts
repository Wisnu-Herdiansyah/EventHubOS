import { describe, expect, it } from 'vitest';
import { nextYearLocal, suggestName, suggestSlug } from './duplicate-event';

describe('duplicate event suggestions', () => {
  it('moves a trailing year forward, or adds -copy', () => {
    expect(suggestSlug('jakarta-summit-2026')).toBe('jakarta-summit-2027');
    expect(suggestSlug('summit')).toBe('summit-copy');
    expect(suggestSlug('a-2026-b')).toBe('a-2026-b-copy');
    // Long slugs are cut to fit: at most 64 characters, still a valid slug, no "--".
    const SLUG = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
    for (const long of [`${'a'.repeat(58)}-bcdef`, `${'a'.repeat(58)}-b`, 'x'.repeat(64)]) {
      const s = suggestSlug(long);
      expect(s.length, s).toBeLessThanOrEqual(64);
      expect(s, s).toMatch(SLUG);
      expect(s, s).not.toMatch(/--/);
      expect(s.endsWith('-copy'), s).toBe(true);
    }
  });

  it('moves a year in the name forward, or adds (copy)', () => {
    expect(suggestName('Jakarta Summit 2026')).toBe('Jakarta Summit 2027');
    expect(suggestName('2026 Kickoff')).toBe('2027 Kickoff');
    expect(suggestName('Summit')).toBe('Summit (copy)');
    expect(suggestName('x'.repeat(200))).toHaveLength(200);
  });

  it('suggests the same local time a year later', () => {
    expect(nextYearLocal('2026-03-01T09:00')).toBe('2027-03-01T09:00');
    expect(nextYearLocal('2028-02-29T18:30')).toBe('2029-02-28T18:30');
    expect(nextYearLocal('not a date')).toBe('not a date');
  });
});
