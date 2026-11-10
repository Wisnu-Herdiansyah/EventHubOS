import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, Stat } from '@/components/ui/card';
import { BarChart } from '@/components/ui/chart';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { attendanceRate, checkInRows, signUpRows } from '@/lib/report';

export const metadata: Metadata = { title: 'Report' };

const UUID = /^[0-9a-f-]{36}$/i;

/** How an event went (ADR-0030): counts only, so Analysts can see it without attendee data. */
export default async function EventReportPage({
  params,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
}) {
  const { orgId, eventId } = await params;
  if (!UUID.test(orgId) || !UUID.test(eventId)) notFound();
  const path = { organizationId: orgId, eventId };
  let org, evt, report;
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
    if (can(org.role, 'report.read')) {
      report = unwrap(
        await client.GET('/v1/organizations/{organizationId}/events/{eventId}/report', {
          params: { path },
        }),
      );
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/events/${eventId}/report`);
  }

  const header = (
    <PageHeader
      breadcrumbs={[
        { label: 'Organizations', href: '/' },
        { label: org.displayName, href: `/orgs/${orgId}` },
        { label: evt.name, href: `/orgs/${orgId}/events/${eventId}` },
        { label: 'Report' },
      ]}
      eyebrow={evt.name}
      title="Report"
      description="Sign-ups and attendance. Counts only; no attendee details."
    />
  );
  if (!report) {
    return (
      <div className="stack">
        {header}
        <Notice>
          Only Owners, Admins, Event managers, Registration managers and Analysts can see reports.
        </Notice>
      </div>
    );
  }

  const t = report.totals;
  const rate = attendanceRate(t.registered, t.checkedIn);
  const days = signUpRows(report.byDay);
  const hours = checkInRows(report.checkInsByHour);
  const zone = `Times in ${report.timezone}.`;

  return (
    <div className="stack">
      {header}
      <div className="grid">
        <Stat
          label="Registered"
          value={t.registered}
          hint={report.capacity ? `of ${report.capacity} seats` : `${t.signUps} signed up in all`}
        />
        <Stat
          label="Checked in"
          value={t.checkedIn}
          hint={rate === null ? 'No registrations yet' : `${rate}% of registered`}
        />
        <Stat
          label="No-shows"
          value={report.ended ? t.noShows : '–'}
          hint={report.ended ? 'Registered, never checked in' : 'Known once the event ends'}
        />
        <Stat label="Cancelled" value={t.cancelled} />
      </div>

      <Card
        title={days.length > 0 && report.byDay.length > 31 ? 'Sign-ups by week' : 'Sign-ups by day'}
        titleId="signups-heading"
      >
        {days.length === 0 ? (
          <EmptyState
            icon="users"
            title="No sign-ups yet"
            description="Sign-ups appear here as people register."
          />
        ) : (
          <BarChart
            caption={report.byDay.length > 31 ? 'Sign-ups by week' : 'Sign-ups by day'}
            valueHeader="Sign-ups"
            data={days.map((d) => ({ ...d, series: 1 as const }))}
            footnote={`Days in ${report.timezone}.${
              report.truncated ? ' Only the most recent year is shown.' : ''
            }`}
          />
        )}
      </Card>

      <Card title="Check-ins by hour" titleId="checkins-heading">
        {hours.length === 0 ? (
          <EmptyState
            icon="check"
            title="No check-ins yet"
            description="Arrivals appear here once door staff start checking people in."
          />
        ) : (
          <BarChart
            caption="Check-ins by hour"
            valueHeader="Check-ins"
            data={hours.map((h) => ({ ...h, series: 1 as const }))}
            footnote={zone}
          />
        )}
      </Card>
    </div>
  );
}
