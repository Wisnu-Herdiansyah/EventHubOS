import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageEditor } from '@/components/patterns/builder';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Microsite' };

const UUID = /^[0-9a-f-]{36}$/i;

/** The event's microsite: edit the draft, publish revisions, see what was published (ADR-0020). */
export default async function EventMicrositePage({
  params,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
}) {
  const { orgId, eventId } = await params;
  if (!UUID.test(orgId) || !UUID.test(eventId)) notFound();
  const path = { organizationId: orgId, eventId };
  let org, evt, page, revisions;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
    [evt, page, revisions] = await Promise.all([
      client
        .GET('/v1/organizations/{organizationId}/events/{eventId}', { params: { path } })
        .then(unwrap),
      client
        .GET('/v1/organizations/{organizationId}/events/{eventId}/page', { params: { path } })
        .then(unwrap),
      client
        .GET('/v1/organizations/{organizationId}/events/{eventId}/page/revisions', {
          params: { path },
        })
        .then(unwrap),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/events/${eventId}/page`);
  }

  const archived = evt.lifecycle === 'archived';
  const canEdit = can(org.role, 'page.edit') && !archived;
  const canPublish = can(org.role, 'event.publish') && !archived;

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: evt.name, href: `/orgs/${orgId}/events/${eventId}` },
          { label: 'Microsite' },
        ]}
        eyebrow={evt.name}
        title="Microsite"
        description={
          <span className="cluster">
            {page.published ? (
              <Badge tone="success" dot>
                Revision {page.published.revision} published
              </Badge>
            ) : (
              <Badge>Not published</Badge>
            )}
            {page.hasUnpublishedChanges ? <Badge tone="warning">Unpublished changes</Badge> : null}
            <span>Drafts are private to your team.</span>
          </span>
        }
      />

      {archived ? (
        <Notice>Archived events are read-only. Restore the event to edit its microsite.</Notice>
      ) : null}
      {page.draft.version === 0 && canEdit ? (
        <Notice role={null}>
          This is a starting outline. Edit the sections, then save your draft.
        </Notice>
      ) : null}

      {/* Not keyed by version: after a save the editor keeps its state (undo, selection). */}
      <PageEditor
        initialSections={page.draft.sections}
        initialVersion={page.draft.version}
        eventName={evt.name}
        timezone={evt.timezone}
        live={{
          organizationId: orgId,
          eventId,
          canEdit,
          canPublish,
          published: page.published,
          hasUnpublishedChanges: page.hasUnpublishedChanges,
        }}
      />

      <Card flush title="Published revisions" titleId="revisions-heading">
        {revisions.data.length === 0 ? (
          <EmptyState
            icon="layers"
            title="Nothing published yet"
            description="Each time you publish, a revision is kept here. Revisions never change."
          />
        ) : (
          <DataTable
            caption="Published revisions"
            rows={revisions.data}
            rowKey={(r) => String(r.revision)}
            columns={[
              {
                key: 'revision',
                header: 'Revision',
                lead: true,
                cell: (r) => <span className="table__primary">Revision {r.revision}</span>,
              },
              {
                key: 'when',
                header: 'Published',
                cell: (r) => formatInZone(r.publishedAt, evt.timezone),
              },
              {
                key: 'by',
                header: 'By',
                cell: (r) => (r.publishedByYou ? 'You' : 'A teammate'),
              },
              {
                key: 'sections',
                header: 'Sections shown',
                align: 'num',
                cell: (r) => `${r.visibleSectionCount} of ${r.sectionCount}`,
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
