import type { SectionKey } from './navigation';

/**
 * Which sidebar entry a path belongs to (pure; unit-tested). Event pages belong to their
 * organization's Overview, where events are listed.
 */
export function activeNav(pathname: string): {
  home: boolean;
  account: boolean;
  orgId: string | null;
  section: SectionKey | null;
} {
  const path = pathname.replace(/\/+$/, '') || '/';
  const org = /^\/orgs\/([^/]+)(?:\/([^/]+))?/.exec(path);
  const sub = org?.[2];
  const section: SectionKey | null = !org
    ? null
    : !sub || sub === 'events'
      ? 'overview'
      : sub === 'team' || sub === 'settings' || sub === 'audit'
        ? sub
        : null;
  return {
    home: path === '/',
    account: path === '/account',
    orgId: org?.[1] ?? null,
    section,
  };
}

/** Initials for an avatar tile: first letters of the first two words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}
