import type { Permission } from '@eventhub/kernel';

/**
 * Event lifecycle (PRD §4): draft -> scheduled -> published -> live -> ended -> archived.
 * Only named transitions exist; anything else is rejected. Publishing makes the event's public
 * site reachable (ADR-0021), so it needs a published page revision and a public handle; the
 * route checks those against the database.
 */
export const LIFECYCLES = ['draft', 'scheduled', 'published', 'live', 'ended', 'archived'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export type ArchivableFrom = 'draft' | 'scheduled' | 'ended';

export interface TransitionRule {
  from: Lifecycle;
  to: Lifecycle;
  permission: Permission;
  /** Scheduling runs the setup checklist. */
  requiresChecklist?: boolean;
  /** Going public needs a published page revision and an organization handle. */
  requiresPublicPage?: boolean;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'draft', to: 'scheduled', permission: 'event.publish', requiresChecklist: true },
  { from: 'scheduled', to: 'draft', permission: 'event.publish' },
  {
    from: 'scheduled',
    to: 'published',
    permission: 'event.publish',
    requiresPublicPage: true,
  },
  // Taking the site offline returns the event to scheduled.
  { from: 'published', to: 'scheduled', permission: 'event.publish' },
  { from: 'published', to: 'live', permission: 'event.publish' },
  { from: 'published', to: 'ended', permission: 'event.publish' },
  { from: 'live', to: 'ended', permission: 'event.publish' },
  { from: 'draft', to: 'archived', permission: 'event.archive' },
  { from: 'scheduled', to: 'archived', permission: 'event.archive' },
  { from: 'ended', to: 'archived', permission: 'event.archive' },
  // Restore returns an archived event to where it came from (checked against archived_from).
  { from: 'archived', to: 'draft', permission: 'event.archive' },
  { from: 'archived', to: 'ended', permission: 'event.archive' },
];

export type TransitionCheck =
  | { ok: true; rule: TransitionRule }
  | {
      ok: false;
      reason: 'invalid_transition' | 'restore_target_mismatch';
    };

/** Restoring a scheduled event goes back to draft: its checklist must be re-run before scheduling. */
export function restoreTarget(archivedFrom: ArchivableFrom): Lifecycle {
  return archivedFrom === 'ended' ? 'ended' : 'draft';
}

export function checkTransition(
  from: Lifecycle,
  to: Lifecycle,
  archivedFrom: ArchivableFrom | null,
): TransitionCheck {
  const rule = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!rule) return { ok: false, reason: 'invalid_transition' };
  if (from === 'archived' && (!archivedFrom || restoreTarget(archivedFrom) !== to)) {
    return { ok: false, reason: 'restore_target_mismatch' };
  }
  return { ok: true, rule };
}

/** Targets offered to the client from the current state (permissions are checked separately). */
export function availableTransitions(
  from: Lifecycle,
  archivedFrom: ArchivableFrom | null,
): Lifecycle[] {
  return TRANSITIONS.filter(
    (t) => t.from === from && checkTransition(from, t.to, archivedFrom).ok,
  ).map((t) => t.to);
}
