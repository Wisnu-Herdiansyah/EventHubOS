/**
 * Which emails still go to an address that bounced or complained (ADR-0043; pure, unit-tested).
 *
 * - requested: answers to something the person just did themselves (verify an address, reset a
 *   password, sign up or sign up again). Always sent: they are asking for it right now, and a
 *   delivery lifts an old bounce.
 * - transactional: news about their own account or booking (security changes, a seat opened, a
 *   cancellation). Sent after a complaint, not to a bouncing address.
 * - organizer: mail someone else chose to send them (announcements, invitations, reminders).
 *   Sent to neither.
 *
 * A template not listed here counts as organizer mail, the most restricted class.
 */
export type EmailClass = 'requested' | 'transactional' | 'organizer';
export type SuppressionReason = 'bounce' | 'complaint';

const CLASSES: Readonly<Record<string, EmailClass>> = {
  verify_email: 'requested',
  password_reset: 'requested', // pragma: allowlist secret
  registration_confirmed: 'requested',
  registration_waitlisted: 'requested',
  registration_reminder: 'requested',
  password_changed: 'transactional', // pragma: allowlist secret
  organization_security_changed: 'transactional',
  registration_promoted: 'transactional',
  registration_cancelled: 'transactional',
  registration_waitlist_left: 'transactional',
  registration_waitlist_closed: 'transactional',
  event_announcement: 'organizer',
  organization_invitation: 'organizer',
  two_step_reminder: 'organizer',
};

export function emailClass(template: string): EmailClass {
  // Two-step verification changes (ADR-0022): mfa_enabled, mfa_disabled, ...
  if (/^mfa_[a-z_]+$/.test(template)) return 'transactional';
  return CLASSES[template] ?? 'organizer';
}

/** Whether an email of this template may go to an address suppressed for `reason`. */
export function maySend(template: string, reason: SuppressionReason | null): boolean {
  if (reason === null) return true;
  const kind = emailClass(template);
  if (kind === 'requested') return true;
  if (kind === 'transactional') return reason === 'complaint';
  return false;
}
