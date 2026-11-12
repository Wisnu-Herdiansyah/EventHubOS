import type { Role } from './permissions.ts';

/**
 * Optional organization emails (ADR-0049). Each member chooses per organization; no row means
 * the default. The database function organization_notice_recipients applies the same roles and
 * default (migration 0031); a test keeps the two in step.
 */
export const NOTIFICATION_KINDS = ['data_download'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATIONS: Readonly<
  Record<NotificationKind, { roles: readonly Role[]; defaultEnabled: boolean }>
> = {
  /** Someone downloaded the attendee list or the audit log (ADR-0049). */
  data_download: { roles: ['owner', 'admin'], defaultEnabled: true },
};

/**
 * Security notices nobody can turn off: they exist so a misused account cannot weaken the
 * organization quietly (ADR-0026, ADR-0045, ADR-0031). Listed so people can see what they get.
 */
export const MANDATORY_NOTICES = [
  'security_settings',
  'support_access',
  'two_step_reminder',
] as const;
export type MandatoryNotice = (typeof MANDATORY_NOTICES)[number];

export const MANDATORY_NOTICE_ROLES: Readonly<Record<MandatoryNotice, readonly Role[]>> = {
  security_settings: ['owner'],
  support_access: ['owner'],
  two_step_reminder: ['owner', 'admin'],
};

export function notificationsFor(role: string): NotificationKind[] {
  return NOTIFICATION_KINDS.filter((k) =>
    (NOTIFICATIONS[k].roles as readonly string[]).includes(role),
  );
}

export function mandatoryNoticesFor(role: string): MandatoryNotice[] {
  return MANDATORY_NOTICES.filter((k) =>
    (MANDATORY_NOTICE_ROLES[k] as readonly string[]).includes(role),
  );
}
