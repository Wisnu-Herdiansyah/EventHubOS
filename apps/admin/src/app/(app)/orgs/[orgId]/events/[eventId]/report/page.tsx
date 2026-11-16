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
import {
  attendanceRate,
  checkInRows,
  ratingRows,
  responseRate,
  signUpRows,
  viewRows,
} from '@/lib/report';
import { formatInZone } from '@/lib/time';

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
  let org, evt, report, feedback, comments;
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
      feedback = unwrap(
        await client.GET('/v1/organizations/{organizationId}/events/{eventId}/feedback', {
          params: { path },
        }),
      );
      // What people wrote is for those who may see attendees (ADR-0063).
      if (feedback.responses > 0 && can(org.role, 'registration.manage')) {
        comments = unwrap(
          await client.GET(
            '/v1/organizations/{organizationId}/events/{eventId}/feedback/comments',
            { params: { path } },
          ),
        );
      }
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
  const views = viewRows(report.pageViewsByDay);
  const viewsByWeek = report.pageViewsByDay.length > 31;
  const zone = `Times in ${report.timezone}.`;
  const timezone = report.timezone;

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
        <Stat
          label="Page views"
          value={t.pageViews}
          hint="Visits to the public page; approximate"
        />
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

      <Card
        title={viewsByWeek ? 'Page views by week' : 'Page views by day'}
        titleId="views-heading"
      >
        {views.length === 0 ? (
          <EmptyState
            icon="eye"
            title="No page views yet"
            description="Visits to the public event page are counted once it is published."
          />
        ) : (
          <BarChart
            caption={viewsByWeek ? 'Page views by week' : 'Page views by day'}
            valueHeader="Views"
            data={views.map((d) => ({ ...d, series: 1 as const }))}
            footnote={`Days in ${report.timezone}. Counts full page loads by people, not bots or link previews; nothing about visitors is stored.`}
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

      {feedback && (feedback.enabled || feedback.asked > 0 || feedback.responses > 0) ? (
        <Card title="Feedback" titleId="feedback-heading">
          {feedback.responses === 0 ? (
            <EmptyState
              icon="users"
              title="No feedback yet"
              description={
                feedback.asked > 0
                  ? `${feedback.asked} ${feedback.asked === 1 ? 'person has' : 'people have'} been asked. Answers appear here as they come in.`
                  : 'People who attended are asked by email when the event ends.'
              }
            />
          ) : (
            <div className="stack">
              <div className="grid">
                <Stat
                  label="Average rating"
                  value={`${feedback.average?.toFixed(1) ?? '–'} / 5`}
                  hint={responseRate(feedback.asked, feedback.responses)}
                />
              </div>
              <BarChart
                caption="Feedback ratings"
                valueHeader="Answers"
                data={ratingRows(feedback.ratings).map((r) => ({ ...r, series: 1 as const }))}
                footnote="Answers are anonymous: you see what was said, not who said it."
              />
              {comments && comments.items.length > 0 ? (
                <section aria-labelledby="feedback-comments-heading" className="stack">
                  <h3 id="feedback-comments-heading">Comments</h3>
                  <div>
                    {comments.items.map((c, i) => (
                      <article key={`${c.submittedAt}-${i}`} className="announcement">
                        <p className="announcement__body">{c.comment}</p>
                        <p className="text-secondary">
                          Rated {c.rating} of 5 · {formatInZone(c.submittedAt, timezone)}
                        </p>
                      </article>
                    ))}
                  </div>
                  {comments.truncated ? (
                    <p className="text-secondary">Only the newest comments are shown.</p>
                  ) : null}
                </section>
              ) : null}
              {!comments && feedback.responses > 0 ? (
                <p className="text-secondary">
                  Comments are shown to people who can manage registrations.
                </p>
              ) : null}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
