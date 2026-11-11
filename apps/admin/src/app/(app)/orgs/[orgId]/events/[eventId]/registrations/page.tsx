import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelRegistrationForm, PromoteRegistrationForm } from '@/components/registration-forms';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
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
  waitlist_removed: 'Removed from the waitlist. They have been emailed.',
  registration_promoted: 'They have a seat now and have been emailed their ticket.',
  export_denied: 'You don’t have permission to download attendee lists.',
};
const FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'confirmed', label: 'Registered' },
  { value: 'waitlisted', label: 'Waitlist' },
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
  const status =
    sp.status === 'confirmed' || sp.status === 'cancelled' || sp.status === 'waitlisted'
      ? sp.status
      : undefined;
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
  const state = registrationStateLabel(summary.state, summary.waitlist);
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
        actions={
          can(org.role, 'attendee.checkin') ? (
            <ButtonLink href={`/orgs/${orgId}/events/${eventId}/check-in`} icon="check">
              Open check-in
            </ButtonLink>
          ) : null
        }
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
        {summary.waitlist || summary.waitlisted > 0 ? (
          <Stat
            label="Waitlist"
            value={summary.waitlisted}
            hint={summary.waitlist ? 'Freed seats go to them in order' : 'Waitlist is off'}
          />
        ) : null}
        <Stat label="Cancelled" value={summary.cancelled} />
        <Stat
          label="Checked in"
          value={summary.checkedIn}
          hint={summary.confirmed > 0 ? `of ${summary.confirmed} registered` : undefined}
        />
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
        <Card
          flush
          title="Attendees"
          titleId="attendees-heading"
          actions={
            can(org.role, 'registration.export_pii') && list.length > 0 ? (
              // A plain form POST: the browser downloads the file and stays on this page.
              <form method="post" action={`${base}/export`}>
                {status ? <input type="hidden" name="status" value={status} /> : null}
                <Button type="submit" variant="secondary" size="sm" icon="download">
                  Download CSV
                </Button>
              </form>
            ) : null
          }
        >
          {can(org.role, 'registration.export_pii') ? null : (
            <p className="card__note text-secondary">
              Downloading attendee lists needs Owner, Admin or Registration manager.
            </p>
          )}
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
              title={
                status === 'waitlisted'
                  ? 'Nobody is waiting'
                  : status
                    ? 'No registrations here'
                    : 'No registrations yet'
              }
              description={
                status === 'waitlisted'
                  ? summary.waitlist
                    ? 'When the event is full, new sign-ups wait here and get freed seats in order.'
                    : 'Turn on the waitlist in the event settings to let people wait for a seat.'
                  : 'People register on the event’s public page once it is published.'
              }
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
                        {r.promotedBy ? 'Registered from waitlist' : 'Registered'}
                      </Badge>
                    ) : r.status === 'waitlisted' ? (
                      <Badge tone="warning" dot>
                        Waiting
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
                    ) : r.status === 'waitlisted' ? (
                      <span className="cluster row-actions">
                        <PromoteRegistrationForm
                          organizationId={orgId}
                          eventId={eventId}
                          registrationId={r.id}
                          name={r.name}
                          idempotencyKey={newIdempotencyKey()}
                          confirmed={summary.confirmed}
                          capacity={summary.capacity}
                        />
                        <CancelRegistrationForm
                          organizationId={orgId}
                          eventId={eventId}
                          registrationId={r.id}
                          name={r.name}
                          idempotencyKey={newIdempotencyKey()}
                          waitlisted
                        />
                      </span>
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
