import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Stat } from '@/components/ui/card';
import { BarChart } from '@/components/ui/chart';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { attendanceRate, monthLabel } from '@/lib/report';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Reports' };

const UUID = /^[0-9a-f-]{36}$/i;

/** Sign-ups and attendance across an organization's events (ADR-0032). Counts only. */
export default async function OrganizationReportsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  const path = { organizationId: orgId };
  let org, report;
  try {
    const client = await api();
    org = unwrap(await client.GET('/v1/organizations/{organizationId}', { params: { path } }));
    if (can(org.role, 'report.read')) {
      report = unwrap(
        await client.GET('/v1/organizations/{organizationId}/report', { params: { path } }),
      );
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/reports`);
  }

  const header = (
    <PageHeader
      breadcrumbs={[
        { label: 'Organizations', href: '/' },
        { label: org.displayName, href: `/orgs/${orgId}` },
        { label: 'Reports' },
      ]}
      eyebrow={org.displayName}
      title="Reports"
      description="Sign-ups and attendance across your events. Counts only; no attendee details."
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
  const timezone = report.timezone;
  const rate = attendanceRate(t.endedRegistered, t.endedCheckedIn);
  return (
    <div className="stack">
      {header}
      <div className="grid">
        <Stat label="Events" value={t.events} hint={`${t.endedEvents} ended`} />
        <Stat label="Registered" value={t.registered} hint={`${t.cancelled} cancelled`} />
        <Stat label="Checked in" value={t.checkedIn} hint="Across all events" />
        <Stat
          label="Attendance"
          value={rate === null ? '–' : `${rate}%`}
          hint={
            rate === null
              ? 'Known once an event with registrations ends'
              : `${t.endedCheckedIn} of ${t.endedRegistered} at ended events`
          }
        />
      </div>

      <Card title="Sign-ups by month" titleId="months-heading">
        <BarChart
          caption="Sign-ups by month"
          valueHeader="Sign-ups"
          data={report.signUpsByMonth.map((m) => ({
            label: monthLabel(m.month),
            value: m.signUps,
            series: 1 as const,
          }))}
          footnote={`The last 12 months, in ${report.timezone}.`}
        />
      </Card>

      <Card flush title="Events" titleId="report-events-heading">
        {report.events.length === 0 ? (
          <EmptyState
            icon="calendar"
            title="No events yet"
            description="Figures appear here once you create events."
          />
        ) : (
          <DataTable
            caption="Events"
            rows={report.events}
            rowKey={(e) => e.id}
            columns={[
              {
                key: 'event',
                header: 'Event',
                lead: true,
                cell: (e) => (
                  <span>
                    <Link
                      className="table__primary wrap-anywhere"
                      href={`/orgs/${orgId}/events/${e.id}/report`}
                    >
                      {e.name}
                    </Link>
                    <span className="table__secondary">{formatInZone(e.startsAt, timezone)}</span>
                  </span>
                ),
              },
              {
                key: 'registered',
                header: 'Registered',
                align: 'num',
                cell: (e) => (e.capacity ? `${e.registered} / ${e.capacity}` : e.registered),
              },
              { key: 'checkedIn', header: 'Checked in', align: 'num', cell: (e) => e.checkedIn },
              {
                key: 'attendance',
                header: 'Attendance',
                align: 'num',
                cell: (e) => {
                  const r = e.ended ? attendanceRate(e.registered, e.checkedIn) : null;
                  return r === null ? '–' : `${r}%`;
                },
              },
            ]}
          />
        )}
        {report.truncated ? (
          <p className="card__note text-secondary door-more">
            Showing the 500 most recent events; the totals above include all of them.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
