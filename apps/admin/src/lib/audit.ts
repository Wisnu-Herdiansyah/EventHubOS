/**
 * Plain-language descriptions of audit records and the filter rules for the audit log page.
 * Pure functions (no I/O) so they are unit-tested. Metadata is rendered as text only.
 */
import { LIFECYCLE_LABELS, ROLE_LABELS } from './options';
import { zonedLocalToIso } from './time';

export interface AuditRecord {
  action: string;
  targetType: string;
  targetId: string | null;
  actor: { type: string; id: string | null; email: string | null };
  metadata: Record<string, unknown>;
}

/** Names the page knows for objects, so records can say "Jakarta Summit" instead of an ID. */
export interface AuditNames {
  members: ReadonlyMap<string, string>;
  events: ReadonlyMap<string, string>;
}

export const AUDIT_CATEGORIES = [
  { value: 'organization.', label: 'Organization settings' },
  { value: 'membership.', label: 'Team and invitations' },
  { value: 'event.', label: 'Events' },
  { value: 'registration.', label: 'Registrations' },
] as const;

const FIELD_LABELS: Record<string, string> = {
  displayName: 'name',
  legalName: 'legal name',
  locale: 'language',
  timezone: 'time zone',
  billingContact: 'billing contact',
  publicHandle: 'public address',
  name: 'name',
  slug: 'URL slug',
  starts_at: 'start time',
  ends_at: 'end time',
  venue_mode: 'format',
  primary_language: 'primary language',
  'settings.visibility': 'visibility',
  'settings.sharing': 'sharing text',
  'settings.legal': 'legal links',
  'settings.contact': 'contact details',
  'settings.registration': 'registration window',
};

const role = (value: unknown) =>
  typeof value === 'string' ? (ROLE_LABELS[value] ?? value) : 'a role';
const lifecycle = (value: unknown) =>
  typeof value === 'string' ? (LIFECYCLE_LABELS[value] ?? value) : '?';
const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);

function fieldList(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'settings';
  const labels = [...new Set(value.map((f) => FIELD_LABELS[String(f)] ?? String(f)))];
  return labels.length === 1
    ? labels[0]!
    : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

export function actorLabel(actor: AuditRecord['actor']): string {
  if (actor.type === 'system') return 'System';
  if (actor.type === 'platform_support') return 'EventHub support';
  return actor.email ?? 'A former member';
}

/** A one-line summary plus optional detail lines. */
export function describeAuditEvent(
  e: AuditRecord,
  names: AuditNames,
): { summary: string; details: string[] } {
  const m = e.metadata;
  const member = (e.targetId && names.members.get(e.targetId)) || 'a former member';
  const event = (e.targetId && names.events.get(e.targetId)) || 'an event';
  const revoked = count(m.revokedInvitations);
  const revokedLine = revoked
    ? [`${revoked} pending invitation${revoked === 1 ? ' was' : 's were'} revoked with it.`]
    : [];

  switch (e.action) {
    case 'organization.created':
      return { summary: 'Created the organization', details: [] };
    case 'organization.updated': {
      // ADR-0024: the security requirement gets its own sentence, not a field name.
      const fields = Array.isArray(m.fields)
        ? m.fields.filter((f) => f !== 'requireMfaForAdmins')
        : [];
      const mfaLine =
        typeof m.requireMfaForAdmins === 'boolean'
          ? m.requireMfaForAdmins
            ? 'Required two-step verification for Owners and Admins'
            : 'Stopped requiring two-step verification for Owners and Admins'
          : null;
      if (mfaLine && fields.length === 0) return { summary: mfaLine, details: [] };
      return {
        summary: `Changed the organization's ${fieldList(fields)}`,
        details: mfaLine ? [`${mfaLine}.`] : [],
      };
    }
    case 'event.created':
      return {
        summary: `Created the event ${event}`,
        details: typeof m.slug === 'string' ? [`URL slug: ${m.slug}`] : [],
      };
    case 'event.updated':
      return { summary: `Changed the ${fieldList(m.fields)} of ${event}`, details: [] };
    case 'event.lifecycle_changed': {
      const skipped = Array.isArray(m.acknowledgedWarnings) ? m.acknowledgedWarnings.length : 0;
      return {
        summary: `Moved ${event} from ${lifecycle(m.from)} to ${lifecycle(m.to)}`,
        details: skipped
          ? [`Acknowledged ${skipped} skipped recommendation${skipped === 1 ? '' : 's'}.`]
          : [],
      };
    }
    case 'event.page_draft_saved':
      return {
        summary: `Saved the microsite draft of ${event}`,
        details: typeof m.draftVersion === 'number' ? [`Draft version ${m.draftVersion}.`] : [],
      };
    case 'event.page_published':
      return {
        summary: `Published the microsite of ${event}`,
        details: typeof m.revision === 'number' ? [`Revision ${m.revision}.`] : [],
      };
    case 'registration.exported': {
      const n = count(m.count);
      const which =
        m.status === 'confirmed' ? 'registered ' : m.status === 'cancelled' ? 'cancelled ' : '';
      return {
        summary: `Downloaded the ${which}attendee list of ${event}`,
        details: [
          `${n} ${n === 1 ? 'person' : 'people'}.`,
          ...(m.truncated === true ? ['The list was cut off at the export limit.'] : []),
        ],
      };
    }
    case 'registration.created': {
      const ev = typeof m.eventId === 'string' ? names.events.get(m.eventId) : undefined;
      return {
        summary: `Someone registered for ${ev ?? 'an event'} on its public page`,
        details: [],
      };
    }
    case 'registration.cancelled': {
      const ev = typeof m.eventId === 'string' ? names.events.get(m.eventId) : undefined;
      return {
        summary:
          m.by === 'attendee'
            ? `An attendee cancelled their registration for ${ev ?? 'an event'}`
            : `Cancelled a registration for ${ev ?? 'an event'}`,
        details: [],
      };
    }
    case 'membership.invited':
      return {
        summary: `Invited ${typeof m.email === 'string' ? m.email : 'someone'} as ${role(m.role)}`,
        details: [],
      };
    case 'membership.invitation_revoked':
      return { summary: `Revoked an invitation for the ${role(m.role)} role`, details: [] };
    case 'membership.accepted':
      return {
        summary: `${m.rejoined === true ? 'Rejoined' : 'Joined'} as ${role(m.role)}`,
        details: [],
      };
    case 'membership.role_changed':
      return {
        summary:
          m.self === true
            ? `Changed their own role from ${role(m.from)} to ${role(m.to)}`
            : `Changed the role of ${member} from ${role(m.from)} to ${role(m.to)}`,
        details: revokedLine,
      };
    case 'membership.removed':
      return {
        summary: m.self === true ? 'Left the organization' : `Removed ${member} (${role(m.role)})`,
        details: revokedLine,
      };
    default:
      return { summary: e.action, details: [] };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const isDate = (v: string) => {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};
const TARGET_TYPES = ['organization', 'membership', 'invitation', 'event'] as const;
export type AuditTargetType = (typeof TARGET_TYPES)[number];

export function isAuditTargetType(value: unknown): value is AuditTargetType {
  return (TARGET_TYPES as readonly unknown[]).includes(value);
}

export interface AuditFilters {
  category?: string;
  actorId?: string;
  targetType?: AuditTargetType;
  targetId?: string;
  fromDate?: string;
  toDate?: string;
  cursor?: string;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Reads filters from the URL. Only well-formed values are kept; anything else is dropped and
 * reported, so a hand-edited URL never reaches the API unchecked.
 */
export function parseAuditFilters(raw: Record<string, string | string[] | undefined>): {
  filters: AuditFilters;
  ignored: boolean;
} {
  const one = (k: string) => (typeof raw[k] === 'string' ? raw[k] : undefined);
  const filters: AuditFilters = {};
  let ignored = false;
  const keep = (
    key: Exclude<keyof AuditFilters, 'targetType'>,
    value: string | undefined,
    ok: boolean,
  ) => {
    if (value === undefined || value === '') return;
    if (ok) filters[key] = value;
    else ignored = true;
  };
  const category = one('category');
  keep(
    'category',
    category,
    AUDIT_CATEGORIES.some((c) => c.value === category),
  );
  keep('actorId', one('actorId'), UUID.test(one('actorId') ?? ''));
  const targetType = one('targetType');
  const targetId = one('targetId');
  if (targetType || targetId) {
    if (isAuditTargetType(targetType) && UUID.test(targetId ?? '')) {
      filters.targetType = targetType;
      filters.targetId = targetId;
    } else {
      ignored = true;
    }
  }
  keep('fromDate', one('from'), isDate(one('from') ?? ''));
  keep('toDate', one('to'), isDate(one('to') ?? ''));
  keep('cursor', one('cursor'), CURSOR.test(one('cursor') ?? ''));
  if (filters.fromDate && filters.toDate && filters.toDate < filters.fromDate) {
    delete filters.toDate;
    ignored = true;
  }
  return { filters, ignored };
}

/** API query for the filters; dates are whole days in the organization's time zone. */
export function auditQuery(filters: AuditFilters, timeZone: string, limit = 50) {
  const from = filters.fromDate ? zonedLocalToIso(`${filters.fromDate}T00:00`, timeZone) : null;
  const to = filters.toDate ? zonedLocalToIso(`${nextDay(filters.toDate)}T00:00`, timeZone) : null;
  return {
    limit,
    ...(filters.category ? { actionPrefix: filters.category } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.targetType && filters.targetId
      ? { targetType: filters.targetType, targetId: filters.targetId }
      : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(filters.cursor ? { cursor: filters.cursor } : {}),
  };
}

/** URL for this page with the given filters (used for paging and "history of this object"). */
export function auditHref(orgId: string, filters: AuditFilters): string {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.actorId) params.set('actorId', filters.actorId);
  if (filters.targetType && filters.targetId) {
    params.set('targetType', filters.targetType);
    params.set('targetId', filters.targetId);
  }
  if (filters.fromDate) params.set('from', filters.fromDate);
  if (filters.toDate) params.set('to', filters.toDate);
  if (filters.cursor) params.set('cursor', filters.cursor);
  const q = params.toString();
  return `/orgs/${orgId}/audit${q ? `?${q}` : ''}`;
}
