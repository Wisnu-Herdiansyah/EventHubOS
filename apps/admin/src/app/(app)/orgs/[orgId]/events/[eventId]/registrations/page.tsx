import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelRegistrationForm } from '@/components/registration-forms';
import { Badge } from '@/components/ui/badge';
import { Card, Stat } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Toast } from '@/components/ui/toast';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { registrationStateLabel, seatsLabel } from '@/lib/registrations';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Registrations' };

const UUID = /^[0-9a-f-]{36}$/i;
const NOTICES: Record<string, string> = {
  registration_cancelled: 'Registration cancelled. The attendee has been emailed.',
};
const FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'confirmed', label: 'Registered' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

/** Who registered for an event (ADR-0023). Attendee details need registration.manage. */
export default async function RegistrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, eventId } = await params;
  const sp = await searchParams;
  if (!UUID.test(orgId) || !UUID.test(eventId)) notFound();
  const status = sp.status === 'confirmed' || sp.status === 'cancelled' ? sp.status : undefined;
  const notice = typeof sp.notice === 'string' ? NOTICES[sp.notice] : undefined;
  const path = { organizationId: orgId, eventId };
  let org, evt, summary, list;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
    [evt, summary] = await Promise.all([
      client
        .GET('/v1/organizations/{organizationId}/events/{eventId}', { params: { path } })
        .then(unwrap),
      client
        .GET('/v1/organizations/{organizationId}/events/{eventId}/registrations/summary', {
          params: { path },
        })
        .then(unwrap),
    ]);
    if (can(org.role, 'registration.manage')) {
      list = unwrap(
        await client.GET('/v1/organizations/{organizationId}/events/{eventId}/registrations', {
          params: { path, query: status ? { status } : {} },
        }),
      ).data;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/events/${eventId}/registrations`);
  }
  const state = registrationStateLabel(summary.state);
  const base = `/orgs/${orgId}/events/${eventId}/registrations`;

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: evt.name, href: `/orgs/${orgId}/events/${eventId}` },
          { label: 'Registrations' },
        ]}
        eyebrow={evt.name}
        title="Registrations"
        description={
          <span className="cluster">
            <Badge tone={state.tone} dot>
              Registration {state.label.toLowerCase()}
            </Badge>
            <span>Closes {formatInZone(summary.closesAt, evt.timezone)}</span>
          </span>
        }
      />
      <Toast message={notice} />

      <div className="grid">
        <Stat
          label="Registered"
          value={seatsLabel(summary.confirmed, summary.capacity)}
          hint={summary.capacity ? 'Seats taken' : 'No capacity limit set'}
        />
        <Stat label="Cancelled" value={summary.cancelled} />
        <Stat
          label="Opens"
          value={summary.opensAt ? formatInZone(summary.opensAt, evt.timezone) : 'When published'}
        />
      </div>

      {!list ? (
        <Notice>
          Only Owners, Admins, Event managers and Registration managers can see attendee details.
        </Notice>
      ) : (
        <Card flush title="Attendees" titleId="attendees-heading">
          <nav aria-label="Filter registrations" className="cluster filter-links">
            {FILTERS.map((f) => (
              <Link
                key={f.label}
                href={f.value ? `${base}?status=${f.value}` : base}
                aria-current={status === f.value ? 'page' : undefined}
                className="filter-link"
              >
                {f.label}
              </Link>
            ))}
          </nav>
          {list.length === 0 ? (
            <EmptyState
              icon="users"
              title={status ? 'No registrations here' : 'No registrations yet'}
              description="People register on the event’s public page once it is published."
            />
          ) : (
            <DataTable
              caption="Attendees"
              rows={list}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  lead: true,
                  cell: (r) => <span className="table__primary wrap-anywhere">{r.name}</span>,
                },
                {
                  key: 'email',
                  header: 'Email',
                  cell: (r) => <span className="wrap-anywhere">{r.email}</span>,
                },
                {
                  key: 'when',
                  header: 'Registered',
                  cell: (r) => formatInZone(r.createdAt, evt.timezone),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (r) =>
                    r.status === 'confirmed' ? (
                      <Badge tone="success" dot>
                        Registered
                      </Badge>
                    ) : (
                      <Badge>
                        {r.cancelledBy === 'organizer' ? 'Cancelled by you' : 'Cancelled'}
                      </Badge>
                    ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  hideHeader: true,
                  align: 'end',
                  cell: (r) =>
                    r.status === 'confirmed' ? (
                      <CancelRegistrationForm
                        organizationId={orgId}
                        eventId={eventId}
                        registrationId={r.id}
                        name={r.name}
                        idempotencyKey={newIdempotencyKey()}
                      />
                    ) : null,
                },
              ]}
            />
          )}
        </Card>
      )}
    </div>
  );
}
