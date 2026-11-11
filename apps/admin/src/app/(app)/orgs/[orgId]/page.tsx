import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreateEventForm } from '@/components/org-forms';
import { Badge } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { Card, Stat } from '@/components/ui/card';
import { BarChart } from '@/components/ui/chart';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { eventsHref, isFiltered, parseEventFilters } from '@/lib/event-filters';
import { LIFECYCLE_LABELS, ROLE_LABELS, timeZones } from '@/lib/options';
import { can } from '@/lib/permissions';
import { lifecycleCounts, lifecycleStatus } from '@/lib/status';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Organization' };

const UUID = /^[0-9a-f-]{36}$/i;

const PAGE_SIZE = 25;

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  const { filters, ignored } = parseEventFilters(await searchParams);
  let org, events, page;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
    // Some roles (e.g. Billing admin) may not read events; don't ask the API for what it will refuse.
    if (can(org.role, 'event.read')) {
      // The figures above the table describe the organization; the table shows the filters.
      [events, page] = await Promise.all([
        client
          .GET('/v1/organizations/{organizationId}/events', {
            params: { path: { organizationId: orgId }, query: { limit: 50 } },
          })
          .then(unwrap)
          .then((r) => r.data),
        client
          .GET('/v1/organizations/{organizationId}/events', {
            params: {
              path: { organizationId: orgId },
              query: {
                limit: PAGE_SIZE,
                ...(filters.q ? { q: filters.q } : {}),
                ...(filters.lifecycle ? { lifecycle: filters.lifecycle as 'draft' } : {}),
                ...(filters.when ? { when: filters.when } : {}),
                ...(filters.cursor ? { cursor: filters.cursor } : {}),
              },
            },
          })
          .then(unwrap),
      ]);
    }
  } catch (error) {
    // Another tenant's organization looks exactly like a missing one.
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}`);
  }

  const pageRows = page?.data ?? [];
  const nextCursor = page?.nextCursor ?? null;
  const canCreate = can(org.role, 'event.create');
  const createForm = canCreate ? (
    <CreateEventForm
      organizationId={orgId}
      idempotencyKey={newIdempotencyKey()}
      timeZones={timeZones()}
      defaultTimeZone={org.timezone}
    />
  ) : null;
  const counts = events ? lifecycleCounts(events) : [];
  const upcoming = (events ?? []).filter(
    (e) =>
      e.lifecycle !== 'archived' && e.lifecycle !== 'ended' && Date.parse(e.endsAt) > Date.now(),
  ).length;

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[{ label: 'Organizations', href: '/' }, { label: org.displayName }]}
        eyebrow="Organization"
        title={org.displayName}
        description={`Your role: ${ROLE_LABELS[org.role] ?? org.role} · ${org.timezone}`}
        actions={
          createForm && events && events.length > 0 ? (
            <Dialog
              kind="sheet"
              trigger={{ label: 'New event', icon: 'plus' }}
              title="New event"
              description="Starts as a draft. Nothing is public until you schedule it."
            >
              {createForm}
            </Dialog>
          ) : null
        }
      />

      {!events ? (
        <Card>
          <EmptyState
            icon="calendar"
            headingLevel={2}
            title="Events are not part of your role"
            description="Ask an Owner or Admin if you need access to this organization’s events."
          />
        </Card>
      ) : events.length === 0 ? (
        // First run: the form sits beside the empty state, one obvious next step.
        <div className="grid-main-aside">
          <Card>
            <EmptyState
              icon="calendar"
              headingLevel={2}
              title="No events yet"
              description={
                canCreate
                  ? 'Create your first event. It starts as a draft, visible only to your team.'
                  : 'Events created by your team will appear here.'
              }
            />
          </Card>
          {createForm ? (
            <Card title="Create an event" titleId="new-event-heading">
              {createForm}
            </Card>
          ) : null}
        </div>
      ) : (
        <>
          <div className="grid">
            <Stat label="Events" value={events.length} />
            <Stat label="Upcoming" value={upcoming} hint="Not ended or archived" />
            <Card title="By status" titleId="status-chart-heading">
              <BarChart
                caption="Events by status"
                valueHeader="Events"
                data={counts.map((c) => ({ label: c.label, value: c.count }))}
              />
            </Card>
          </div>
          <Card flush title="Events" titleId="events-heading">
            <form method="get" action={`/orgs/${orgId}`} className="event-filters">
              <SearchField
                label="Search events"
                name="q"
                defaultValue={filters.q}
                placeholder="Search by name or URL slug"
                maxLength={100}
              />
              <div className="field">
                <label className="visually-hidden" htmlFor="filter-status">
                  Status
                </label>
                <select
                  id="filter-status"
                  name="status"
                  className="select"
                  defaultValue={filters.lifecycle ?? ''}
                >
                  <option value="">Any status</option>
                  {Object.entries(LIFECYCLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="visually-hidden" htmlFor="filter-when">
                  When
                </label>
                <select
                  id="filter-when"
                  name="when"
                  className="select"
                  defaultValue={filters.when ?? ''}
                >
                  <option value="">Any time</option>
                  <option value="upcoming">Upcoming</option>
                  <option value="past">Past</option>
                </select>
              </div>
              <button type="submit" className="btn btn--secondary">
                Filter
              </button>
              {isFiltered(filters) ? (
                <a className={buttonClass({ variant: 'plain' })} href={eventsHref(orgId, {})}>
                  Clear
                </a>
              ) : null}
            </form>
            {ignored ? (
              <div className="card__note">
                <Notice>Some filters in the link were not valid and were ignored.</Notice>
              </div>
            ) : null}
            {pageRows.length === 0 ? (
              <EmptyState
                icon="search"
                title="No events match"
                description="Try other words, or clear the filters."
              />
            ) : (
              <DataTable
                caption="Events"
                rows={pageRows}
                rowKey={(e) => e.id}
                columns={[
                  {
                    key: 'name',
                    header: 'Event',
                    lead: true,
                    cell: (e) => (
                      <Link className="table__primary" href={`/orgs/${orgId}/events/${e.id}`}>
                        {e.name}
                      </Link>
                    ),
                  },
                  {
                    key: 'starts',
                    header: 'Starts',
                    cell: (e) => formatInZone(e.startsAt, e.timezone),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    align: 'end',
                    cell: (e) => {
                      const st = lifecycleStatus(e.lifecycle);
                      return (
                        <Badge tone={st.tone} dot>
                          {st.label}
                        </Badge>
                      );
                    },
                  },
                ]}
              />
            )}
            {nextCursor || filters.cursor ? (
              <nav aria-label="Event pages" className="cluster pager">
                {filters.cursor ? (
                  <a
                    className={buttonClass({ variant: 'plain' })}
                    href={eventsHref(orgId, { ...filters, cursor: undefined })}
                  >
                    First page
                  </a>
                ) : null}
                {nextCursor ? (
                  <a
                    className={buttonClass({ variant: 'secondary' })}
                    href={eventsHref(orgId, filters, nextCursor)}
                  >
                    Next page
                  </a>
                ) : null}
              </nav>
            ) : null}
          </Card>
        </>
      )}
    </div>
  );
}
