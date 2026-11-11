import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AnnouncementForm } from '@/components/announcement-form';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Toast } from '@/components/ui/toast';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Announcements' };

const UUID = /^[0-9a-f-]{36}$/i;
const NOTICES: Record<string, string> = {
  sent: 'Announcement sent. Emails go out in the next few moments.',
};

/** Email everyone signed up for an event (ADR-0037). */
export default async function AnnouncementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, eventId } = await params;
  if (!UUID.test(orgId) || !UUID.test(eventId)) notFound();
  const sp = await searchParams;
  const notice = typeof sp.notice === 'string' ? NOTICES[sp.notice] : undefined;
  const path = { organizationId: orgId, eventId };
  let org, evt, summary, sent;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
    evt = unwrap(
      await client.GET('/v1/organizations/{organizationId}/events/{eventId}', { params: { path } }),
    );
    if (can(org.role, 'communication.send')) {
      [summary, sent] = await Promise.all([
        client
          .GET('/v1/organizations/{organizationId}/events/{eventId}/registrations/summary', {
            params: { path },
          })
          .then(unwrap),
        client
          .GET('/v1/organizations/{organizationId}/events/{eventId}/announcements', {
            params: { path },
          })
          .then(unwrap)
          .then((r) => r.data),
      ]);
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/events/${eventId}/announcements`);
  }
  const timezone = evt.timezone;

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: evt.name, href: `/orgs/${orgId}/events/${eventId}` },
          { label: 'Announcements' },
        ]}
        eyebrow={evt.name}
        title="Announcements"
        description="Email everyone signed up for this event, for example about a new venue or time."
      />
      <Toast message={notice} />
      {!summary || !sent ? (
        <Notice>Only Owners, Admins and Event managers can send announcements.</Notice>
      ) : (
        <>
          <Card title="New announcement" titleId="compose-heading">
            {evt.lifecycle === 'archived' ? (
              <Notice>Archived events are read-only.</Notice>
            ) : summary.confirmed + summary.waitlisted === 0 ? (
              <EmptyState
                icon="users"
                title="Nobody to email yet"
                description="Announcements go to the people registered for the event."
              />
            ) : (
              <AnnouncementForm
                organizationId={orgId}
                eventId={eventId}
                eventName={evt.name}
                idempotencyKey={newIdempotencyKey()}
                registered={summary.confirmed}
                waitlisted={summary.waitlisted}
              />
            )}
            <p className="text-secondary text-sm">
              Up to 3 announcements per event in any 24 hours. Cancelled registrations are never
              emailed.
            </p>
          </Card>

          <Card title="Sent" titleId="sent-heading">
            {sent.length === 0 ? (
              <p className="text-secondary">Nothing sent yet.</p>
            ) : (
              <ul className="stack announcement-list" aria-label="Sent announcements">
                {sent.map((a) => {
                  const pending = a.recipients - a.delivered - a.skipped;
                  return (
                    <li key={a.id} className="stack-sm announcement">
                      <div className="cluster">
                        <strong className="wrap-anywhere">{a.subject}</strong>
                        <Badge tone={pending > 0 ? 'accent' : 'success'} dot>
                          {pending > 0
                            ? `Sending: ${a.delivered} of ${a.recipients}`
                            : `Delivered to ${a.delivered}`}
                        </Badge>
                      </div>
                      <p className="text-secondary text-sm">
                        {formatInZone(a.createdAt, timezone)}
                        {a.sentBy ? ` · by ${a.sentBy}` : ''} ·{' '}
                        {a.audience === 'registered_and_waitlist'
                          ? 'Registered and waitlist'
                          : 'Registered'}
                        {a.skipped > 0 ? ` · ${a.skipped} skipped (cancelled meanwhile)` : ''}
                      </p>
                      <p className="announcement__body">{a.body}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
