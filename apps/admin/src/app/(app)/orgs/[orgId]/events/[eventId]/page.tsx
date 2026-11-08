import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EventSettingsForm, TransitionForm, type SettingsDefaults } from '@/components/org-forms';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Meter } from '@/components/ui/chart';
import { Icon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs } from '@/components/ui/tabs';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { auditHref } from '@/lib/audit';
import { lifecycleStatus } from '@/lib/status';
import { formatInZone, isoToZonedLocal } from '@/lib/time';

export const metadata: Metadata = { title: 'Event' };

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
  ended: { label: 'Restore as ended', tone: 'secondary' },
};

export default async function EventPage({
  params,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
}) {
  const { orgId, eventId } = await params;
  if (!UUID.test(orgId) || !UUID.test(eventId)) notFound();
  const path = { organizationId: orgId, eventId };
  let org, evt, checklist;
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
  };
  const warnings = checklist.items
    .filter((i) => i.severity === 'recommended' && !i.complete)
    .map((i) => ({ id: i.id, message: i.message }));
  const canEdit = can(org.role, 'event.update') && evt.lifecycle !== 'archived';
  const restoreLabel = evt.lifecycle === 'archived' ? 'Restore event' : undefined;

  const status = lifecycleStatus(evt.lifecycle);
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
            description="Move the event through draft, scheduled and archived."
          >
            <div className="stack-sm">
              {checklist.availableTransitions.map((to) => {
                const meta = TRANSITION_LABELS[to] ?? {
                  label: `Move to ${to}`,
                  tone: 'secondary' as const,
                };
                const label =
                  evt.lifecycle === 'archived' && restoreLabel ? restoreLabel : meta.label;
                if (to === 'scheduled' && !checklist.canSchedule) {
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
                    description={meta.description}
                    idempotencyKey={newIdempotencyKey()}
                    warnings={to === 'scheduled' ? warnings : undefined}
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
                    name={item.complete ? 'check' : item.severity === 'blocking' ? 'close' : 'info'}
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
            {can(org.role, 'audit.read') ? (
              <ButtonLink
                variant="secondary"
                icon="history"
                href={auditHref(orgId, { targetType: 'event', targetId: eventId })}
              >
                View history
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
