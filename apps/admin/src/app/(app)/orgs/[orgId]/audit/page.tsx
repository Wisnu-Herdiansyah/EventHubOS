import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { DateInput } from '@/components/ui/date-input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
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
  const sp = await searchParams;
  const { filters, ignored } = parseAuditFilters(sp);
  const exportDenied = sp.notice === 'export_denied';
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
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: 'Audit log' },
        ]}
        eyebrow={org.displayName}
        title="Audit log"
        description={`Who changed what, newest first. Times are in ${org.timezone}.`}
      />

      {!page ? (
        <Notice>Only Owners and Admins can see the audit log.</Notice>
      ) : (
        <>
          <Card title="Filters" titleId="filters-heading">
            <form method="get" action={`/orgs/${orgId}/audit`} className="form">
              {filters.targetType && filters.targetId ? (
                <>
                  <input type="hidden" name="targetType" value={filters.targetType} />
                  <input type="hidden" name="targetId" value={filters.targetId} />
                </>
              ) : null}
              <div className="form__row">
                <div className="field">
                  <label className="field__label" htmlFor="audit-category">
                    Category
                  </label>
                  <select
                    id="audit-category"
                    name="category"
                    className="select"
                    defaultValue={filters.category ?? ''}
                  >
                    <option value="">All activity</option>
                    {AUDIT_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="audit-actor">
                    Person
                  </label>
                  <select
                    id="audit-actor"
                    name="actorId"
                    className="select"
                    defaultValue={filters.actorId ?? ''}
                  >
                    <option value="">Anyone</option>
                    {(members ?? []).map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.email}
                      </option>
                    ))}
                  </select>
                </div>
                <DateInput id="audit-from" name="from" label="From" value={filters.fromDate} />
                <DateInput id="audit-to" name="to" label="To" value={filters.toDate} />
              </div>
              <div className="form__actions">
                <button type="submit" className="btn">
                  Apply filters
                </button>
                <ButtonLink variant="plain" href={`/orgs/${orgId}/audit`}>
                  Clear filters
                </ButtonLink>
              </div>
            </form>
          </Card>

          {exportDenied ? (
            <Notice>You don’t have permission to download the audit log.</Notice>
          ) : null}
          {ignored ? (
            <Notice>Some filters in the link were not valid and were ignored.</Notice>
          ) : null}
          {objectLabel ? (
            <Notice>
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
            </Notice>
          ) : null}

          <Card title="Activity" titleId="entries-heading">
            {org.role !== 'support' ? (
              <form method="post" action={`/orgs/${orgId}/audit/export`} className="form__actions">
                {filters.category ? (
                  <input type="hidden" name="category" value={filters.category} />
                ) : null}
                {filters.actorId ? (
                  <input type="hidden" name="actorId" value={filters.actorId} />
                ) : null}
                {filters.targetType && filters.targetId ? (
                  <>
                    <input type="hidden" name="targetType" value={filters.targetType} />
                    <input type="hidden" name="targetId" value={filters.targetId} />
                  </>
                ) : null}
                {filters.fromDate ? (
                  <input type="hidden" name="from" value={filters.fromDate} />
                ) : null}
                {filters.toDate ? <input type="hidden" name="to" value={filters.toDate} /> : null}
                <button type="submit" className="btn btn--secondary btn--sm">
                  Download CSV
                </button>
                <span className="list__meta">
                  Matches these filters, newest first, up to 10,000 entries. Downloads are recorded
                  in this log.
                </span>
              </form>
            ) : null}
            {page.data.length === 0 ? (
              <EmptyState
                icon="history"
                title="No activity matches these filters"
                description="Try a wider date range or clear the filters."
              />
            ) : (
              <ol className="list">
                {page.data.map((e) => {
                  const { summary, details } = describeAuditEvent(e, names);
                  const focusType = isAuditTargetType(e.targetType) ? e.targetType : null;
                  const canFocus =
                    focusType &&
                    e.targetId &&
                    !(filters.targetType === focusType && filters.targetId === e.targetId);
                  return (
                    <li key={e.id} className="list__item">
                      <div className="list__main">
                        <p className="list__meta cluster">
                          <time dateTime={e.occurredAt}>
                            {formatInZone(e.occurredAt, org.timezone)}
                          </time>
                          <span className="audit-actor">{actorLabel(e.actor)}</span>
                        </p>
                        <p className="wrap-anywhere">{summary}</p>
                        {details.map((d) => (
                          <p key={d} className="list__meta">
                            {d}
                          </p>
                        ))}
                        <p className="list__meta cluster">
                          {canFocus ? (
                            <Link
                              className="audit-link"
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
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <nav className="form__actions" aria-label="Audit log pages">
              {filters.cursor ? (
                <ButtonLink variant="secondary" size="sm" href={auditHref(orgId, focus(filters))}>
                  Back to newest
                </ButtonLink>
              ) : null}
              {page.nextCursor ? (
                <ButtonLink
                  variant="secondary"
                  size="sm"
                  href={auditHref(orgId, { ...filters, cursor: page.nextCursor })}
                >
                  Older entries
                </ButtonLink>
              ) : null}
            </nav>
          </Card>
        </>
      )}
    </div>
  );
}
