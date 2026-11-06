import type { EventSettings } from './settings.ts';

/**
 * Setup checklist (EVT-03). Deterministic: the same event state always yields the same result.
 * Blocking items stop scheduling; recommended items must be explicitly acknowledged.
 */
export type ChecklistSeverity = 'blocking' | 'recommended';

export interface ChecklistItem {
  id: string;
  severity: ChecklistSeverity;
  complete: boolean;
  message: string;
}

export interface ChecklistInput {
  name: string;
  startsAt: Date;
  settings: EventSettings;
  now: Date;
}

export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const s = input.settings;
  const isPrivate = s.visibility === 'private';
  return [
    {
      id: 'schedule.starts_in_future',
      severity: 'blocking',
      complete: input.startsAt.getTime() > input.now.getTime(),
      message: 'The event start time must be in the future.',
    },
    {
      id: 'sharing.metadata',
      severity: 'blocking',
      // Required public metadata; private events are never shared publicly.
      complete: isPrivate || Boolean(s.sharing?.title && s.sharing.description),
      message: 'Add a sharing title and description (used for search and social previews).',
    },
    {
      id: 'legal.privacy_policy',
      severity: 'blocking',
      complete: Boolean(s.legal?.privacyPolicyUrl),
      message: 'Link a privacy policy. Attendee data and consent depend on it.',
    },
    {
      id: 'contact.details',
      severity: 'recommended',
      complete: Boolean(s.contact?.email || s.contact?.url || s.contact?.phone),
      message: 'Add a contact email, phone, or page so attendees can reach the organizer.',
    },
    {
      id: 'registration.window',
      severity: 'recommended',
      complete: Boolean(s.registration?.opensAt && s.registration.closesAt),
      message: 'Set when registration opens and closes.',
    },
    {
      id: 'legal.terms',
      severity: 'recommended',
      complete: Boolean(s.legal?.termsUrl),
      message: 'Link terms and conditions.',
    },
  ];
}

export interface ChecklistEvaluation {
  blockingIncomplete: string[];
  unacknowledgedWarnings: string[];
}

export function evaluateForScheduling(
  items: ChecklistItem[],
  acknowledged: readonly string[],
): ChecklistEvaluation {
  const ack = new Set(acknowledged);
  return {
    blockingIncomplete: items
      .filter((i) => i.severity === 'blocking' && !i.complete)
      .map((i) => i.id),
    unacknowledgedWarnings: items
      .filter((i) => i.severity === 'recommended' && !i.complete && !ack.has(i.id))
      .map((i) => i.id),
  };
}
