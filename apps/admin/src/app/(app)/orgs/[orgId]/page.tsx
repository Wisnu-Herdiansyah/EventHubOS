import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreateEventForm } from '@/components/org-forms';
import { Badge } from '@/components/ui/badge';
import { Card, Stat } from '@/components/ui/card';
import { BarChart } from '@/components/ui/chart';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { ROLE_LABELS, timeZones } from '@/lib/options';
import { can } from '@/lib/permissions';
import { lifecycleCounts, lifecycleStatus } from '@/lib/status';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Organization' };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function OrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  let org, events;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
    // Some roles (e.g. Billing admin) may not read events; don't ask the API for what it will refuse.
    if (can(org.role, 'event.read')) {
      events = unwrap(
        await client.GET('/v1/organizations/{organizationId}/events', {
          params: { path: { organizationId: orgId }, query: { limit: 50 } },
        }),
      ).data;
    }
  } catch (error) {
    // Another tenant's organization looks exactly like a missing one.
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}`);
  }

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
            <DataTable
              caption="Events"
              rows={events}
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
          </Card>
        </>
      )}
    </div>
  );
}
