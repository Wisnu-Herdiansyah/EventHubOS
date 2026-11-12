/**
 * Public page themes (ADR-0046): preset colour sets whose contrast is checked in
 * packages/microsite/src/site-tokens.test.ts. Organizers choose one; nobody types colours, so
 * a page can never become unreadable. 'default' is the platform's own blue.
 */
export const EVENT_THEMES = ['default', 'navy-gold', 'forest', 'ember'] as const;
export type EventTheme = (typeof EVENT_THEMES)[number];
