import { describe, expect, it } from 'vitest';
import { parseSidebar, parseTheme, preferenceCookie } from './preferences';

describe('display preferences', () => {
  it('accepts only known themes and falls back to the system setting', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('system')).toBe('system');
    expect(parseTheme(undefined)).toBe('system');
    expect(parseTheme('"><script>')).toBe('system');
  });

  it('keeps the sidebar expanded unless collapsed was chosen', () => {
    expect(parseSidebar('collapsed')).toBe('collapsed');
    expect(parseSidebar('expanded')).toBe('expanded');
    expect(parseSidebar('bogus')).toBe('expanded');
    expect(parseSidebar(undefined)).toBe('expanded');
  });

  it('writes same-site cookies, Secure over HTTPS', () => {
    expect(preferenceCookie('eventhub_theme', 'dark', true)).toBe(
      'eventhub_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    );
    expect(preferenceCookie('eventhub_theme', 'dark', false)).not.toContain('Secure');
  });
});
