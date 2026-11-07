import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ResendVerificationForm } from '@/components/auth-forms';
import { CreateOrganizationForm } from '@/components/org-forms';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { LOCALES, ROLE_LABELS, timeZones } from '@/lib/options';
import { readSessionToken } from '@/lib/session';

// The layout's title template applies to child routes only, not to this root page.
export const metadata: Metadata = { title: { absolute: 'Organizations · EventHub OS' } };

export default async function HomePage() {
  if (!(await readSessionToken())) redirect('/login');
  let me, orgs;
  try {
    const client = await api();
    me = unwrap(await client.GET('/v1/me'));
    orgs = unwrap(await client.GET('/v1/me/organizations')).data;
  } catch (error) {
    signInOn401(error, '/');
  }

  const createForm = (
    <CreateOrganizationForm
      idempotencyKey={newIdempotencyKey()}
      timeZones={timeZones()}
      locales={LOCALES}
    />
  );
  const verify = (
    <div className="stack-sm">
      <Notice tone="warning" title="Verify your email first">
        Verify your email address ({me.email}) before creating an organization. Check your inbox for
        the link.
      </Notice>
      <ResendVerificationForm idempotencyKey={newIdempotencyKey()} />
    </div>
  );

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Your workspace"
        title="Organizations"
        description="Each organization has its own events, team and settings."
        actions={
          orgs.length > 0 && me.emailVerified ? (
            <Dialog
              kind="sheet"
              trigger={{ label: 'New organization', icon: 'plus' }}
              title="New organization"
              description="You become its Owner. You can change these details later."
            >
              {createForm}
            </Dialog>
          ) : null
        }
      />

      {orgs.length === 0 ? (
        // First run: the empty state carries the form itself, so there is one obvious next step.
        <div className="grid-main-aside">
          <Card>
            <EmptyState
              icon="building"
              headingLevel={2}
              title="No organizations yet"
              description="Create one for your company or client, or ask a teammate to invite you to theirs."
            />
          </Card>
          <Card title="Create an organization" titleId="new-org-heading">
            {me.emailVerified ? createForm : verify}
          </Card>
        </div>
      ) : (
        <>
          {me.emailVerified ? null : verify}
          <Card flush title="Your organizations" titleId="orgs-heading">
            <DataTable
              caption="Your organizations"
              rows={orgs}
              rowKey={(o) => o.organizationId}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  lead: true,
                  cell: (o) => (
                    <Link className="table__primary" href={`/orgs/${o.organizationId}`}>
                      {o.displayName}
                    </Link>
                  ),
                },
                {
                  key: 'role',
                  header: 'Your role',
                  align: 'end',
                  cell: (o) => <Badge>{ROLE_LABELS[o.role] ?? o.role}</Badge>,
                },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
