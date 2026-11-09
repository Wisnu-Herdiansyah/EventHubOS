import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { api, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { ROLE_LABELS } from '@/lib/options';

export const metadata: Metadata = { title: 'Two-step verification required' };

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * ADR-0024: an Owner or Admin of an organization that requires two-step verification, who has not
 * set it up, lands here instead of on the organization's pages. The API enforces the rule; this
 * page only explains it and points to the account page.
 */
export default async function TwoStepRequiredPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string | string[] }>;
}) {
  const { org: orgParam } = await searchParams;
  const orgId = typeof orgParam === 'string' && UUID.test(orgParam) ? orgParam : null;
  if (!orgId) notFound();
  const here = `/two-step-required?org=${orgId}`;
  let org;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, here);
  }
  // Already set up (or the requirement was lifted): nothing to explain.
  if (!org.mfaSetupRequired) redirect(`/orgs/${orgId}`);

  const role = ROLE_LABELS[org.role] ?? org.role;
  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[{ label: 'Organizations', href: '/' }, { label: org.displayName }]}
        eyebrow={org.displayName}
        title="Two-step verification required"
      />
      <Card>
        <EmptyState
          icon="lock"
          headingLevel={2}
          title="Set up two-step verification to continue"
          description={`${org.displayName} requires two-step verification for Owners and Admins. As ${role === 'Owner' ? 'an Owner' : 'an Admin'}, your access to its events, team and settings is paused until it is on. It takes a minute with an authenticator app.`}
          action={
            <div className="cluster">
              <ButtonLink href="/account#two-step-heading" variant="primary" icon="lock">
                Set up two-step verification
              </ButtonLink>
              <ButtonLink href="/" variant="secondary">
                Back to your organizations
              </ButtonLink>
            </div>
          }
        />
      </Card>
    </div>
  );
}
