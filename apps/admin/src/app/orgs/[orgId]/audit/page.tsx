import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, signInOn401, unwrap } from '@/lib/api';
import {
  AUDIT_CATEGORIES,
  actorLabel,
  auditHref,
  auditQuery,
  describeAuditEvent,
  isAuditTargetType,
  parseAuditFilters,
  type AuditFilters,
} from '@/lib/audit';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Audit log' };

const UUID = /^[0-9a-f-]{36}$/i;

const OBJECT_NAMES: Record<string, string> = {
  organization: 'the organization',
  membership: 'member',
  invitation: 'invitation',
  event: 'event',
};

export default async function AuditLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  const { filters, ignored } = parseAuditFilters(await searchParams);
  const path = { organizationId: orgId };

  let org, page, members, events;
  try {
    const client = await api();
    org = unwrap(await client.GET('/v1/organizations/{organizationId}', { params: { path } }));
    if (can(org.role, 'audit.read')) {
      const [audit, memberList, eventList] = await Promise.all([
        client.GET('/v1/organizations/{organizationId}/audit-events', {
          params: { path, query: auditQuery(filters, org.timezone) },
        }),
        can(org.role, 'membership.read')
          ? client.GET('/v1/organizations/{organizationId}/members', { params: { path } })
          : null,
        can(org.role, 'event.read')
          ? client.GET('/v1/organizations/{organizationId}/events', {
              params: { path, query: { limit: 100 } },
            })
          : null,
      ]);
      page = unwrap(audit);
      members = memberList ? unwrap(memberList).data : [];
      events = eventList ? unwrap(eventList).data : [];
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, auditHref(orgId, filters));
  }

  const names = {
    members: new Map((members ?? []).map((m) => [m.membershipId, m.email])),
    events: new Map((events ?? []).map((e) => [e.id, e.name])),
  };
  const focus = (f: AuditFilters) => ({ ...f, cursor: undefined });
  const objectLabel =
    filters.targetType && filters.targetId
      ? filters.targetType === 'event'
        ? (names.events.get(filters.targetId) ?? 'an event')
        : filters.targetType === 'membership'
          ? (names.members.get(filters.targetId) ?? 'a former member')
          : filters.targetType === 'organization'
            ? 'the organization'
            : 'an invitation'
      : null;

  return (
    <div className="stack">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">Organizations</Link>
          </li>
          <li>
            <Link href={`/orgs/${orgId}`}>{org.displayName}</Link>
          </li>
          <li aria-current="page">Audit log</li>
        </ol>
      </nav>
      <div className="page-head">
        <div>
          <p className="eyebrow">{org.displayName}</p>
          <h1>Audit log</h1>
          <p className="muted">Who changed what, newest first. Times are in {org.timezone}.</p>
        </div>
      </div>

      {!page ? (
        <div className="message info" role="status">
          Only Owners and Admins can see the audit log.
        </div>
      ) : (
        <>
          <section className="card" aria-labelledby="filters-heading">
            <h2 id="filters-heading">Filters</h2>
            <form method="get" action={`/orgs/${orgId}/audit`} className="filters">
              {filters.targetType && filters.targetId ? (
                <>
                  <input type="hidden" name="targetType" value={filters.targetType} />
                  <input type="hidden" name="targetId" value={filters.targetId} />
                </>
              ) : null}
              <div className="field">
                <label htmlFor="audit-category">Category</label>
                <select id="audit-category" name="category" defaultValue={filters.category ?? ''}>
                  <option value="">All activity</option>
                  {AUDIT_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="audit-actor">Person</label>
                <select id="audit-actor" name="actorId" defaultValue={filters.actorId ?? ''}>
                  <option value="">Anyone</option>
                  {(members ?? []).map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="audit-from">From</label>
                <input id="audit-from" name="from" type="date" defaultValue={filters.fromDate} />
              </div>
              <div className="field">
                <label htmlFor="audit-to">To</label>
                <input id="audit-to" name="to" type="date" defaultValue={filters.toDate} />
              </div>
              <div className="actions">
                <button type="submit">Apply filters</button>
                <Link href={`/orgs/${orgId}/audit`}>Clear filters</Link>
              </div>
            </form>
          </section>

          {ignored ? (
            <div className="message info" role="status">
              Some filters in the link were not valid and were ignored.
            </div>
          ) : null}
          {objectLabel ? (
            <div className="message info" role="status">
              Showing the history of {objectLabel}.{' '}
              <Link
                href={auditHref(orgId, {
                  ...focus(filters),
                  targetType: undefined,
                  targetId: undefined,
                })}
              >
                Show all activity
              </Link>
            </div>
          ) : null}

          <section className="card accent" aria-labelledby="entries-heading">
            <h2 id="entries-heading">Activity</h2>
            {page.data.length === 0 ? (
              <p className="muted">No activity matches these filters.</p>
            ) : (
              <ol className="audit-list">
                {page.data.map((e) => {
                  const { summary, details } = describeAuditEvent(e, names);
                  const focusType = isAuditTargetType(e.targetType) ? e.targetType : null;
                  const canFocus =
                    focusType &&
                    e.targetId &&
                    !(filters.targetType === focusType && filters.targetId === e.targetId);
                  return (
                    <li key={e.id}>
                      <div className="audit-head">
                        <time dateTime={e.occurredAt}>
                          {formatInZone(e.occurredAt, org.timezone)}
                        </time>
                        <span className="audit-actor">{actorLabel(e.actor)}</span>
                      </div>
                      <p className="audit-summary">{summary}</p>
                      {details.map((d) => (
                        <p key={d} className="hint">
                          {d}
                        </p>
                      ))}
                      <p className="audit-meta">
                        {canFocus ? (
                          <Link
                            href={auditHref(orgId, {
                              ...focus(filters),
                              targetType: focusType,
                              targetId: e.targetId ?? undefined,
                            })}
                          >
                            {e.targetType === 'organization'
                              ? 'History of the organization'
                              : `History of this ${OBJECT_NAMES[e.targetType]}`}
                          </Link>
                        ) : null}
                        <span className="reference">Reference: {e.correlationId}</span>
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
            <nav className="actions" aria-label="Audit log pages">
              {filters.cursor ? (
                <Link href={auditHref(orgId, focus(filters))}>Back to newest</Link>
              ) : null}
              {page.nextCursor ? (
                <Link href={auditHref(orgId, { ...filters, cursor: page.nextCursor })}>
                  Older entries
                </Link>
              ) : null}
            </nav>
          </section>
        </>
      )}
    </div>
  );
}
