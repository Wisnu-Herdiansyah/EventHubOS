import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EventSettingsForm, TransitionForm, type SettingsDefaults } from '@/components/org-forms';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { LIFECYCLE_LABELS } from '@/lib/options';
import { can } from '@/lib/permissions';
import { auditHref } from '@/lib/audit';
import { formatInZone, isoToZonedLocal } from '@/lib/time';

export const metadata: Metadata = { title: 'Event' };

const UUID = /^[0-9a-f-]{36}$/i;

const TRANSITION_LABELS: Record<
  string,
  { label: string; tone: 'primary' | 'secondary' | 'danger' }
> = {
  scheduled: { label: 'Schedule event', tone: 'primary' },
  draft: { label: 'Move back to draft', tone: 'secondary' },
  archived: { label: 'Archive event', tone: 'danger' },
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

  return (
    <div className="stack">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">Organizations</Link>
          </li>
          <li>
            <Link href={`/orgs/${orgId}`}>{org.displayName}</Link>
          </li>
          <li aria-current="page">{evt.name}</li>
        </ol>
      </nav>
      <div className="page-head">
        <div>
          <p className="eyebrow">Event</p>
          <h1>{evt.name}</h1>
          <p>
            <span className={`badge ${evt.lifecycle}`}>
              {LIFECYCLE_LABELS[evt.lifecycle] ?? evt.lifecycle}
            </span>
          </p>
          {can(org.role, 'audit.read') ? (
            <ul className="section-links" aria-label="Event sections">
              <li>
                <Link href={auditHref(orgId, { targetType: 'event', targetId: eventId })}>
                  View history
                </Link>
              </li>
            </ul>
          ) : null}
        </div>
      </div>

      <div className="grid">
        <section className="card accent" aria-labelledby="details-heading">
          <h2 id="details-heading">Details</h2>
          <dl className="details">
            <dt>Starts</dt>
            <dd>{formatInZone(evt.startsAt, evt.timezone)}</dd>
            <dt>Ends</dt>
            <dd>{formatInZone(evt.endsAt, evt.timezone)}</dd>
            <dt>Time zone</dt>
            <dd>{evt.timezone}</dd>
            <dt>Slug</dt>
            <dd>{evt.slug}</dd>
            <dt>Language</dt>
            <dd>{evt.primaryLanguage}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="checklist-heading">
          <h2 id="checklist-heading">Setup checklist</h2>
          <ul className="checklist">
            {checklist.items.map((item) => (
              <li key={item.id} className={`${item.complete ? 'done' : 'todo'} ${item.severity}`}>
                <span className="icon" aria-hidden="true">
                  {item.complete ? '✓' : item.severity === 'blocking' ? '✕' : '!'}
                </span>
                <span>
                  <span className="visually-hidden">{item.complete ? 'Done: ' : 'To do: '}</span>
                  {item.message}
                  <span className="severity">
                    {item.severity === 'blocking' ? 'Required' : 'Recommended'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {checklist.availableTransitions.length > 0 ? (
        <section aria-labelledby="lifecycle-heading">
          <h2 id="lifecycle-heading">Lifecycle</h2>
          <div className="grid">
            {checklist.availableTransitions.map((to) => {
              const meta = TRANSITION_LABELS[to] ?? {
                label: `Move to ${to}`,
                tone: 'secondary' as const,
              };
              const label =
                evt.lifecycle === 'archived' && restoreLabel ? restoreLabel : meta.label;
              if (to === 'scheduled' && !checklist.canSchedule) {
                return (
                  <div key={to} className="card">
                    <p className="muted">
                      Complete the required checklist items to schedule this event.
                    </p>
                  </div>
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
                  idempotencyKey={newIdempotencyKey()}
                  warnings={to === 'scheduled' ? warnings : undefined}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {canEdit ? (
        <section className="card" aria-labelledby="settings-heading">
          <h2 id="settings-heading">Settings</h2>
          <EventSettingsForm
            organizationId={orgId}
            eventId={eventId}
            version={evt.version}
            timeZone={evt.timezone}
            idempotencyKey={newIdempotencyKey()}
            defaults={defaults}
          />
        </section>
      ) : evt.lifecycle === 'archived' ? (
        <div className="message info" role="status">
          Archived events are read-only. Restore the event to edit it.
        </div>
      ) : null}
    </div>
  );
}
