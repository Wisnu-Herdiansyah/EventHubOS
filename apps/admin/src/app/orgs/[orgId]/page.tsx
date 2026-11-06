import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreateEventForm } from '@/components/org-forms';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { LIFECYCLE_LABELS, ROLE_LABELS, timeZones } from '@/lib/options';
import { can, teamAbilities } from '@/lib/permissions';
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
    events = unwrap(
      await client.GET('/v1/organizations/{organizationId}/events', {
        params: { path: { organizationId: orgId }, query: { limit: 50 } },
      }),
    ).data;
  } catch (error) {
    // Another tenant's organization looks exactly like a missing one.
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}`);
  }

  return (
    <div className="stack">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">Organizations</Link>
          </li>
          <li aria-current="page">{org.displayName}</li>
        </ol>
      </nav>
      <div className="page-head">
        <div>
          <p className="eyebrow">Organization</p>
          <h1>{org.displayName}</h1>
          <p className="muted">
            Your role: {ROLE_LABELS[org.role] ?? org.role} · {org.timezone}
          </p>
          {teamAbilities(org.role).canRead ? (
            <ul className="section-links" aria-label="Organization sections">
              <li>
                <Link href={`/orgs/${orgId}/team`}>Team</Link>
              </li>
            </ul>
          ) : null}
        </div>
      </div>
      <div className="grid">
        <section className="card accent" aria-labelledby="events-heading">
          <h2 id="events-heading">Events</h2>
          {events.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            <ul className="list">
              {events.map((e) => (
                <li key={e.id}>
                  <span>
                    <Link href={`/orgs/${orgId}/events/${e.id}`}>{e.name}</Link>
                    <span className="hint">{formatInZone(e.startsAt, e.timezone)}</span>
                  </span>
                  <span className={`badge ${e.lifecycle}`}>
                    {LIFECYCLE_LABELS[e.lifecycle] ?? e.lifecycle}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {can(org.role, 'event.create') ? (
          <section className="card" aria-labelledby="new-event-heading">
            <h2 id="new-event-heading">Create an event</h2>
            <CreateEventForm
              organizationId={orgId}
              idempotencyKey={newIdempotencyKey()}
              timeZones={timeZones()}
              defaultTimeZone={org.timezone}
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
