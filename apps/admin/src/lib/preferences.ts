/**
 * Display preferences kept in plain cookies (no personal data, nothing secret), read on the server
 * so the first paint already has the right theme and sidebar width. Pure; unit-tested.
 */
export const THEME_COOKIE = 'eventhub_theme';
export const SIDEBAR_COOKIE = 'eventhub_sidebar';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export type SidebarState = 'expanded' | 'collapsed';

export function parseTheme(value: string | undefined): Theme {
  return (THEMES as readonly string[]).includes(value ?? '') ? (value as Theme) : 'system';
}

export function parseSidebar(value: string | undefined): SidebarState {
  return value === 'collapsed' ? 'collapsed' : 'expanded';
}

/** A year-long, same-site preference cookie; Secure whenever the page is served over HTTPS. */
export function preferenceCookie(name: string, value: string, https: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${https ? '; Secure' : ''}`;
}
