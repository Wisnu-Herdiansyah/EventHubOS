import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buttonClass } from '@/components/ui/button';
import { Card, Stat } from '@/components/ui/card';
import { BarChart } from '@/components/ui/chart';
import { DataTable } from '@/components/ui/data-table';
import { DateInput } from '@/components/ui/date-input';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { attendanceRate, monthLabel } from '@/lib/report';
import {
  monthsFootnote,
  PERIOD_PRESETS,
  periodLabel,
  periodSearch,
  resolvePeriod,
  todayIn,
} from '@/lib/report-period';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Reports' };

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Sign-ups and attendance across an organization's events (ADR-0032), for a period of event
 * start dates in the organization's time zone (ADR-0034). Counts only.
 */
export default async function OrganizationReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  const sp = await searchParams;
  const path = { organizationId: orgId };
  let org, report, today, resolved;
  try {
    const client = await api();
    org = unwrap(await client.GET('/v1/organizations/{organizationId}', { params: { path } }));
    today = todayIn(org.timezone);
    resolved = resolvePeriod(sp, today);
    if (can(org.role, 'report.read')) {
      const { from, to } = resolved.period;
      report = unwrap(
        await client.GET('/v1/organizations/{organizationId}/report', {
          params: { path, query: from && to ? { from, to } : {} },
        }),
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
  const period = resolved.period;
  const base = `/orgs/${orgId}/reports`;
  const rate = attendanceRate(t.endedRegistered, t.endedCheckedIn);
  const scope = period.key === 'all' ? 'Across all events' : 'Across events in this period';
  return (
    <div className="stack">
      {header}
      <Card title="Period" titleId="period-heading">
        <div className="stack-sm">
          <nav aria-label="Report period" className="cluster filter-links filter-links--inline">
            {PERIOD_PRESETS.map((p) => (
              <Link
                key={p.key}
                href={`${base}${periodSearch({ key: p.key })}`}
                aria-current={period.key === p.key ? 'page' : undefined}
                className="filter-link"
              >
                {p.label}
              </Link>
            ))}
          </nav>
          <form method="get" action={base} className="form" aria-label="Custom period">
            <input type="hidden" name="period" value="custom" />
            <div className="form__row">
              <DateInput
                id="report-from"
                name="from"
                label="From"
                value={period.from}
                required
                min="2000-01-01"
                max="2099-12-31"
              />
              <DateInput
                id="report-to"
                name="to"
                label="To"
                value={period.to}
                required
                min="2000-01-01"
                max="2099-12-31"
              />
            </div>
            <div className="form__actions">
              <button type="submit" className="btn btn--secondary">
                Show custom period
              </button>
            </div>
          </form>
          <p className="text-secondary text-sm" id="period-summary">
            Showing <strong>{periodLabel(period)}</strong>
            {period.key === 'all' ? '' : `: events that start on these days, in ${timezone}`}.
          </p>
        </div>
      </Card>
      {resolved.invalid ? (
        <Notice tone="warning">
          That period was not valid (both dates are needed, and the start must not be after the
          end), so all time is shown.
        </Notice>
      ) : null}
      <div className="grid">
        <Stat label="Events" value={t.events} hint={`${t.endedEvents} ended`} />
        <Stat label="Registered" value={t.registered} hint={`${t.cancelled} cancelled`} />
        <Stat label="Checked in" value={t.checkedIn} hint={scope} />
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
          footnote={monthsFootnote(report)}
        />
      </Card>

      <Card
        flush
        title="Events"
        titleId="report-events-heading"
        actions={
          report.events.length > 0 ? (
            // A plain link, not next/link: prefetching would fetch the file.
            <a
              href={`${base}/export${periodSearch(period)}`}
              download
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              <Icon name="download" size={18} />
              Download CSV
            </a>
          ) : null
        }
      >
        {report.events.length === 0 ? (
          <EmptyState
            icon="calendar"
            title={period.key === 'all' ? 'No events yet' : 'No events in this period'}
            description={
              period.key === 'all'
                ? 'Figures appear here once you create events.'
                : 'Choose another period, or all time.'
            }
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
            Showing the 500 most recent events (the download has the same 500); the totals above
            include all of them.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
