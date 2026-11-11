import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  DuplicateEventForm,
  EventSettingsForm,
  TransitionForm,
  type SettingsDefaults,
} from '@/components/org-forms';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Meter } from '@/components/ui/chart';
import { Icon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Toast } from '@/components/ui/toast';
import { Tabs } from '@/components/ui/tabs';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { auditHref } from '@/lib/audit';
import { lifecycleStatus } from '@/lib/status';
import { adminConfig } from '@/lib/config';
import { publicSiteUrl } from '@/lib/public-url';
import { registrationStateLabel, seatsLabel } from '@/lib/registrations';
import { formatInZone, isoToZonedLocal } from '@/lib/time';
import { nextYearLocal, suggestName, suggestSlug } from '@/lib/duplicate-event';

export const metadata: Metadata = { title: 'Event' };

const NOTICES: Record<string, string> = {
  duplicated:
    'Event duplicated. This copy is a draft: check its settings and page, then publish it when ready.',
};

const UUID = /^[0-9a-f-]{36}$/i;

const TRANSITION_LABELS: Record<
  string,
  { label: string; tone: 'primary' | 'secondary' | 'danger'; description?: string }
> = {
  scheduled: {
    label: 'Schedule event',
    tone: 'primary',
    description: 'Confirms the date; the event can then be published.',
  },
  draft: { label: 'Move back to draft', tone: 'secondary' },
  archived: {
    label: 'Archive event',
    tone: 'danger',
    description: 'Makes the event read-only. You can restore it later.',
  },
  published: {
    label: 'Publish event',
    tone: 'primary',
    description: 'Opens the public page at its address.',
  },
  live: { label: 'Mark as live', tone: 'secondary', description: 'The event is happening now.' },
  ended: { label: 'End event', tone: 'secondary', description: 'The public page stays up.' },
};

/** Labels that depend on where the event is now. */
function transitionMeta(from: string, to: string) {
  if (from === 'archived') return { label: 'Restore event', tone: 'secondary' as const };
  if (from === 'published' && to === 'scheduled') {
    return {
      label: 'Take offline',
      tone: 'secondary' as const,
      description: 'The public page stops working until you publish again.',
    };
  }
  return TRANSITION_LABELS[to] ?? { label: `Move to ${to}`, tone: 'secondary' as const };
}

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, eventId } = await params;
  const sp = await searchParams;
  const notice = typeof sp.notice === 'string' ? NOTICES[sp.notice] : undefined;
  if (!UUID.test(orgId) || !UUID.test(eventId)) notFound();
  const path = { organizationId: orgId, eventId };
  let org, evt, checklist, regSummary;
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
    checklist = unwrap(
      await client.GET('/v1/organizations/{organizationId}/events/{eventId}/checklist', {
        params: { path },
      }),
    );
    regSummary = unwrap(
      await client.GET(
        '/v1/organizations/{organizationId}/events/{eventId}/registrations/summary',
        {
          params: { path },
        },
      ),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/events/${eventId}`);
  }

  const s = evt.settings;
  const local = (iso?: string) => (iso ? isoToZonedLocal(iso, evt.timezone) : '');
  const defaults: SettingsDefaults = {
    visibility: s.visibility ?? 'public',
    title: s.sharing?.title ?? '',
    description: s.sharing?.description ?? '',
    privacyPolicyUrl: s.legal?.privacyPolicyUrl ?? '',
    termsUrl: s.legal?.termsUrl ?? '',
    email: s.contact?.email ?? '',
    contactUrl: s.contact?.url ?? '',
    opensAt: local(s.registration?.opensAt),
    closesAt: local(s.registration?.closesAt),
    capacity: s.registration?.capacity ? String(s.registration.capacity) : '',
    waitlist: s.registration?.waitlist === true,
  };
  const warnings = checklist.items
    .filter((i) => i.severity === 'recommended' && !i.complete)
    .map((i) => ({ id: i.id, message: i.message }));
  const canEdit = can(org.role, 'event.update') && evt.lifecycle !== 'archived';
  const site = checklist.publicSite;
  const publicUrl = publicSiteUrl(adminConfig().publicSiteUrl, site.handle, site.eventSlug);
  const isPublic =
    ['published', 'live', 'ended'].includes(evt.lifecycle) && s.visibility !== 'private';
  const publishBlockers = [
    ...(site.pagePublished
      ? []
      : [
          {
            text: 'Publish a revision of the microsite.',
            href: `/orgs/${orgId}/events/${eventId}/page`,
            link: 'Open the microsite',
          },
        ]),
    ...(site.handle
      ? []
      : [
          {
            text: 'Choose a public address for the organization.',
            href: `/orgs/${orgId}/settings`,
            link: 'Open settings',
          },
        ]),
    ...(s.visibility === 'private'
      ? [{ text: 'Set the visibility to Public or Unlisted in the Settings tab.' }]
      : []),
  ];

  const status = lifecycleStatus(evt.lifecycle);
  const regState = registrationStateLabel(regSummary.state, regSummary.waitlist);
  const done = checklist.items.filter((i) => i.complete).length;

  const overview = (
    <div className="grid-main-aside">
      <div className="stack">
        <Card title="Details" titleId="details-heading">
          <dl className="details">
            <dt>Starts</dt>
            <dd>{formatInZone(evt.startsAt, evt.timezone)}</dd>
            <dt>Ends</dt>
            <dd>{formatInZone(evt.endsAt, evt.timezone)}</dd>
            <dt>Time zone</dt>
            <dd>{evt.timezone}</dd>
            <dt>Slug</dt>
            <dd className="text-mono">{evt.slug}</dd>
            <dt>Language</dt>
            <dd>{evt.primaryLanguage}</dd>
          </dl>
        </Card>

        {checklist.availableTransitions.length > 0 ? (
          <Card
            title="Lifecycle"
            titleId="lifecycle-heading"
            description="Draft, scheduled, published, live, ended and archived."
          >
            <div className="stack-sm">
              {checklist.availableTransitions.map((to) => {
                const meta = transitionMeta(evt.lifecycle, to);
                const label = meta.label;
                if (to === 'published' && publishBlockers.length > 0) {
                  return (
                    <Notice key={to} tone="warning" role={null} title="Before publishing">
                      <ul className="issue-list">
                        {publishBlockers.map((b) => (
                          <li key={b.text}>
                            {b.text}{' '}
                            {'href' in b && b.href ? <Link href={b.href}>{b.link}</Link> : null}
                          </li>
                        ))}
                      </ul>
                    </Notice>
                  );
                }
                if (to === 'scheduled' && evt.lifecycle === 'draft' && !checklist.canSchedule) {
                  return (
                    <Notice key={to} tone="warning" role={null}>
                      Complete the required checklist items to schedule this event.
                    </Notice>
                  );
                }
                return (
                  <TransitionForm
                    key={to}
                    organizationId={orgId}
                    eventId={eventId}
                    version={evt.version}
                    to={to}
                    label={label}
                    tone={meta.tone}
                    description={'description' in meta ? meta.description : undefined}
                    idempotencyKey={newIdempotencyKey()}
                    // Skipped recommendations are acknowledged when scheduling a draft only.
                    warnings={
                      to === 'scheduled' && evt.lifecycle === 'draft' ? warnings : undefined
                    }
                  />
                );
              })}
            </div>
          </Card>
        ) : null}

        {evt.lifecycle === 'archived' ? (
          <Notice>Archived events are read-only. Restore the event to edit it.</Notice>
        ) : null}
      </div>

      <div className="stack">
        <Card title="Registrations" titleId="registrations-heading">
          <div className="stack-sm">
            <Badge tone={regState.tone} dot>
              Registration {regState.label.toLowerCase()}
            </Badge>
            <p>
              <strong>{seatsLabel(regSummary.confirmed, regSummary.capacity)}</strong> registered
            </p>
            {regSummary.waitlisted > 0 ? (
              <p className="text-secondary">{regSummary.waitlisted} on the waitlist</p>
            ) : null}
            {regSummary.checkedIn > 0 ? (
              <p className="text-secondary">{regSummary.checkedIn} checked in</p>
            ) : null}
            <Link href={`/orgs/${orgId}/events/${eventId}/registrations`}>See registrations</Link>
            {can(org.role, 'attendee.checkin') ? (
              <Link href={`/orgs/${orgId}/events/${eventId}/check-in`}>Open check-in</Link>
            ) : null}
          </div>
        </Card>
        <Card title="Public page" titleId="public-page-heading">
          {isPublic && publicUrl ? (
            <div className="stack-sm">
              <Badge tone="success" dot>
                Public
              </Badge>
              <a
                className="wrap-anywhere"
                href={publicUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {publicUrl}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </div>
          ) : isPublic ? (
            <p className="text-secondary">
              Public at {site.handle}/{site.eventSlug}. Set ADMIN_PUBLIC_SITE_URL to link to it.
            </p>
          ) : (
            <p className="text-secondary">
              Not public. Publish the event to open its page
              {site.handle ? '' : ' (after choosing a public address)'}.
            </p>
          )}
        </Card>
        <Card title="Setup checklist" titleId="checklist-heading">
          <div className="stack-sm">
            <Meter value={done} max={checklist.items.length} label="Complete" />
            <ul className="checklist">
              {checklist.items.map((item) => (
                <li
                  key={item.id}
                  className={`checklist__item ${item.complete ? 'checklist__item--done' : `checklist__item--${item.severity}`}`}
                >
                  <span className="checklist__icon" aria-hidden="true">
                    <Icon
                      name={
                        item.complete ? 'check' : item.severity === 'blocking' ? 'close' : 'info'
                      }
                      size={14}
                    />
                  </span>
                  <span>
                    <span className="visually-hidden">{item.complete ? 'Done: ' : 'To do: '}</span>
                    {item.message}
                    <span className="checklist__severity">
                      {item.severity === 'blocking' ? 'Required' : 'Recommended'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </div>
  );

  const settings = canEdit ? (
    <Card
      className="narrow"
      title="Settings"
      titleId="settings-heading"
      description="Sharing, legal, contact and registration details for this event."
    >
      <EventSettingsForm
        organizationId={orgId}
        eventId={eventId}
        version={evt.version}
        timeZone={evt.timezone}
        idempotencyKey={newIdempotencyKey()}
        defaults={defaults}
      />
    </Card>
  ) : null;

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: evt.name },
        ]}
        eyebrow="Event"
        title={evt.name}
        description={
          <span className="cluster">
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            <span>{formatInZone(evt.startsAt, evt.timezone)}</span>
          </span>
        }
        actions={
          <>
            {can(org.role, 'event.create') ? (
              <DuplicateEventForm
                organizationId={orgId}
                eventId={eventId}
                timeZone={evt.timezone}
                idempotencyKey={newIdempotencyKey()}
                defaults={{
                  name: suggestName(evt.name),
                  slug: suggestSlug(evt.slug),
                  startsAt: nextYearLocal(isoToZonedLocal(evt.startsAt, evt.timezone)),
                }}
              />
            ) : null}
            {can(org.role, 'audit.read') ? (
              <ButtonLink
                variant="secondary"
                icon="history"
                href={auditHref(orgId, { targetType: 'event', targetId: eventId })}
              >
                View history
              </ButtonLink>
            ) : null}
            <ButtonLink
              variant="secondary"
              icon="users"
              href={`/orgs/${orgId}/events/${eventId}/registrations`}
            >
              Registrations
            </ButtonLink>
            {can(org.role, 'report.read') ? (
              <ButtonLink
                variant="secondary"
                icon="overview"
                href={`/orgs/${orgId}/events/${eventId}/report`}
              >
                Report
              </ButtonLink>
            ) : null}
            <ButtonLink icon="layers" href={`/orgs/${orgId}/events/${eventId}/page`}>
              {can(org.role, 'page.edit') && evt.lifecycle !== 'archived'
                ? 'Edit microsite'
                : 'View microsite'}
            </ButtonLink>
          </>
        }
      />
      <Toast message={notice} />
      {settings ? (
        <Tabs
          label="Event sections"
          tabs={[
            { id: 'overview', label: 'Overview', panel: overview },
            { id: 'settings', label: 'Settings', panel: settings },
          ]}
        />
      ) : (
        overview
      )}
    </div>
  );
}
