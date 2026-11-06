import type { Permission } from '@eventhub/kernel';

/**
 * Event lifecycle (PRD §4): draft -> scheduled -> published -> live -> ended -> archived.
 * Only named transitions exist; anything else is rejected. Transitions that need a published
 * public revision are defined but unavailable until page publishing (Phase 2) and routing
 * (Phase 3) exist, so they fail explicitly rather than pretending to publish.
 */
export const LIFECYCLES = ['draft', 'scheduled', 'published', 'live', 'ended', 'archived'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export type ArchivableFrom = 'draft' | 'scheduled' | 'ended';

export interface TransitionRule {
  from: Lifecycle;
  to: Lifecycle;
  permission: Permission;
  /** Why the transition cannot run yet, when it depends on unbuilt capabilities. */
  unavailable?: 'requires_published_revision';
  /** Scheduling runs the setup checklist. */
  requiresChecklist?: boolean;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'draft', to: 'scheduled', permission: 'event.publish', requiresChecklist: true },
  { from: 'scheduled', to: 'draft', permission: 'event.publish' },
  {
    from: 'scheduled',
    to: 'published',
    permission: 'event.publish',
    unavailable: 'requires_published_revision',
  },
  {
    from: 'published',
    to: 'live',
    permission: 'event.publish',
    unavailable: 'requires_published_revision',
  },
  {
    from: 'published',
    to: 'ended',
    permission: 'event.publish',
    unavailable: 'requires_published_revision',
  },
  {
    from: 'live',
    to: 'ended',
    permission: 'event.publish',
    unavailable: 'requires_published_revision',
  },
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
      reason: 'invalid_transition' | 'requires_published_revision' | 'restore_target_mismatch';
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
  if (rule.unavailable) return { ok: false, reason: rule.unavailable };
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
