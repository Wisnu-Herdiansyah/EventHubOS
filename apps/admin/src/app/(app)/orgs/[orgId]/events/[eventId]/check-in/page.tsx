import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CheckInDesk } from '@/components/check-in-desk';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';

export const metadata: Metadata = { title: 'Check-in' };

const UUID = /^[0-9a-f-]{36}$/i;

/** Event-day check-in at the door (ADR-0028). Needs attendee.checkin. */
export default async function CheckInPage({
  params,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
}) {
  const { orgId, eventId } = await params;
  if (!UUID.test(orgId) || !UUID.test(eventId)) notFound();
  const path = { organizationId: orgId, eventId };
  let org, evt, list;
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
    if (can(org.role, 'attendee.checkin')) {
      list = unwrap(
        await client.GET('/v1/organizations/{organizationId}/events/{eventId}/check-in', {
          params: { path, query: {} },
        }),
      );
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/events/${eventId}/check-in`);
  }

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: evt.name, href: `/orgs/${orgId}/events/${eventId}` },
          { label: 'Check-in' },
        ]}
        eyebrow={evt.name}
        title="Check-in"
        description="Find each attendee as they arrive and check them in."
      />
      {list ? (
        <CheckInDesk
          organizationId={orgId}
          eventId={eventId}
          timezone={evt.timezone}
          initial={list}
        />
      ) : (
        <Notice>Only Owners, Admins and Registration managers can check attendees in.</Notice>
      )}
    </div>
  );
}
