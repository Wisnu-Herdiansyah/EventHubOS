import type { Tone } from '@/components/ui/badge';
import { LIFECYCLE_LABELS } from './options';

/**
 * One mapping from domain states to badge tones, so a status looks the same on every screen
 * (pure; unit-tested). Unknown states fall back to neutral with their raw name.
 */
const LIFECYCLE_TONES: Record<string, Tone> = {
  draft: 'neutral',
  scheduled: 'accent',
  published: 'success',
  live: 'success',
  ended: 'neutral',
  archived: 'warning',
};

const INVITATION: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  accepted: { label: 'Accepted', tone: 'success' },
  revoked: { label: 'Revoked', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

export function lifecycleStatus(lifecycle: string): { label: string; tone: Tone } {
  return {
    label: LIFECYCLE_LABELS[lifecycle] ?? lifecycle,
    tone: LIFECYCLE_TONES[lifecycle] ?? 'neutral',
  };
}

export function invitationStatus(status: string): { label: string; tone: Tone } {
  return INVITATION[status] ?? { label: status, tone: 'neutral' };
}

/** Roles the organization's two-step requirement covers (ADR-0024; kernel MFA_ENFORCED_ROLES). */
const MFA_ROLES = new Set(['owner', 'admin']);

/**
 * ADR-0025: a member's two-step verification, as shown on the Team page. "Needed" marks the
 * people the organization's requirement is currently holding out.
 */
export function twoStepStatus(
  enabled: boolean,
  role: string,
  orgRequires: boolean,
): { label: string; tone: Tone } {
  if (enabled) return { label: 'On', tone: 'success' };
  if (orgRequires && MFA_ROLES.has(role)) return { label: 'Needed', tone: 'danger' };
  return { label: 'Off', tone: 'neutral' };
}

/** Reminders are limited to one per member per day (ADR-0031). */
export function remindedRecently(at: string | null | undefined, now: Date = new Date()): boolean {
  if (!at) return false;
  return now.getTime() - Date.parse(at) < 24 * 60 * 60 * 1000;
}

/** Owners and Admins who do not use two-step verification yet. */
export function adminsWithoutTwoStep<T extends { role: string; twoStepEnabled?: boolean }>(
  members: T[],
): T[] {
  return members.filter((m) => MFA_ROLES.has(m.role) && m.twoStepEnabled === false);
}

/** Events per lifecycle state, in lifecycle order, omitting empty states except Draft. */
export function lifecycleCounts(
  events: Array<{ lifecycle: string }>,
): Array<{ lifecycle: string; label: string; count: number }> {
  const order = Object.keys(LIFECYCLE_LABELS);
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.lifecycle, (counts.get(e.lifecycle) ?? 0) + 1);
  const known = order.filter((s) => s === 'draft' || counts.has(s));
  const unknown = [...counts.keys()].filter((s) => !order.includes(s)).sort();
  return [...known, ...unknown].map((s) => ({
    lifecycle: s,
    label: LIFECYCLE_LABELS[s] ?? s,
    count: counts.get(s) ?? 0,
  }));
}
