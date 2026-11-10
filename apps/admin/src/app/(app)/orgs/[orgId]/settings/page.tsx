import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  BillingContactForm,
  OrganizationProfileForm,
  PublicHandleForm,
  TwoStepRequirementForm,
} from '@/components/org-forms';
import { Card } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError, twoStepRequiredPath } from '@/lib/errors';
import { LOCALES, ROLE_LABELS, timeZones } from '@/lib/options';
import { adminConfig } from '@/lib/config';
import { settingsAbilities } from '@/lib/permissions';
import { publicSiteExample, publicSiteUrl } from '@/lib/public-url';
import { adminsWithoutTwoStep } from '@/lib/status';

export const metadata: Metadata = { title: 'Organization settings' };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  let org, mfa, members;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
    if (settingsAbilities(org.role).canEditProfile && !org.mfaSetupRequired) {
      mfa = unwrap(await client.GET('/v1/auth/mfa'));
      // ADR-0025: who the requirement would hold out (membership.manage sees two-step status).
      members = unwrap(
        await client.GET('/v1/organizations/{organizationId}/members', {
          params: { path: { organizationId: orgId } },
        }),
      ).data;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/settings`);
  }

  // The API would refuse every change; explain why instead of showing forms that cannot save.
  if (org.mfaSetupRequired) redirect(twoStepRequiredPath(`/orgs/${orgId}/settings`));

  const abilities = settingsAbilities(org.role);
  const withoutTwoStep = adminsWithoutTwoStep((members ?? []).filter((m) => m.status === 'active'));
  const siteTemplate = adminConfig().publicSiteUrl;
  const siteOrigin = publicSiteUrl(siteTemplate, org.publicHandle);
  const billing = org.billingContact;

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: 'Settings' },
        ]}
        eyebrow={org.displayName}
        title="Settings"
        description={`Your role: ${ROLE_LABELS[org.role] ?? org.role}`}
      />

      {!abilities.canOpen ? (
        <Notice>Only Owners, Admins and Billing admins can see organization settings.</Notice>
      ) : (
        <div className="grid">
          <Card
            title="Profile"
            titleId="profile-heading"
            description="How the organization is named and where it works."
          >
            {abilities.canEditProfile ? (
              <OrganizationProfileForm
                organizationId={orgId}
                version={org.version}
                idempotencyKey={newIdempotencyKey()}
                timeZones={timeZones()}
                locales={LOCALES}
                defaults={{
                  displayName: org.displayName,
                  legalName: org.legalName ?? '',
                  locale: org.locale,
                  timezone: org.timezone,
                }}
              />
            ) : (
              <div className="stack-sm">
                <dl className="details">
                  <dt>Organization name</dt>
                  <dd>{org.displayName}</dd>
                  <dt>Legal name</dt>
                  <dd>{org.legalName ?? 'Not set'}</dd>
                  <dt>Language</dt>
                  <dd>{org.locale}</dd>
                  <dt>Time zone</dt>
                  <dd>{org.timezone}</dd>
                </dl>
                <p className="field__hint">Owners and Admins can change the profile.</p>
              </div>
            )}
          </Card>

          <Card
            title="Public address"
            titleId="public-address-heading"
            description="Where published event pages live."
          >
            {abilities.canEditProfile ? (
              <PublicHandleForm
                organizationId={orgId}
                version={org.version}
                idempotencyKey={newIdempotencyKey()}
                handle={org.publicHandle ?? ''}
                example={publicSiteExample(siteTemplate, org.publicHandle)}
              />
            ) : (
              <div className="stack-sm">
                <p>{org.publicHandle ?? 'Not chosen yet.'}</p>
                <p className="field__hint">Owners and Admins can change the public address.</p>
              </div>
            )}
            {siteOrigin ? (
              <p className="field__hint">
                Organization address: <span className="text-mono">{siteOrigin}</span>
              </p>
            ) : null}
          </Card>

          {abilities.canEditProfile ? (
            <Card
              title="Security"
              titleId="security-heading"
              description="Extra protection for the people who can change everything."
            >
              <TwoStepRequirementForm
                organizationId={orgId}
                version={org.version}
                idempotencyKey={newIdempotencyKey()}
                required={org.requireMfaForAdmins}
              />
              {withoutTwoStep.length > 0 ? (
                <p className="field__hint">
                  {withoutTwoStep.length === 1
                    ? '1 Owner or Admin doesn’t'
                    : `${withoutTwoStep.length} Owners and Admins don’t`}{' '}
                  use two-step verification yet.{' '}
                  <Link href={`/orgs/${orgId}/team`}>See who on the Team page</Link>.
                </p>
              ) : null}
              {mfa?.status === 'on' ? null : (
                <p className="field__hint">
                  You don’t use two-step verification yet.{' '}
                  <Link href="/account#two-step-heading">Set it up</Link> before requiring it.
                </p>
              )}
            </Card>
          ) : null}

          {abilities.canReadBilling || abilities.canEditBilling ? (
            <Card
              title="Billing contact"
              titleId="billing-heading"
              description="Who receives invoices and payment notices."
            >
              {abilities.canEditBilling ? (
                <BillingContactForm
                  organizationId={orgId}
                  version={org.version}
                  idempotencyKey={newIdempotencyKey()}
                  defaults={{ name: billing?.name ?? '', email: billing?.email ?? '' }}
                />
              ) : (
                <div className="stack-sm">
                  {billing?.name && billing.email ? (
                    <dl className="details">
                      <dt>Name</dt>
                      <dd>{billing.name}</dd>
                      <dt>Email</dt>
                      <dd>{billing.email}</dd>
                    </dl>
                  ) : (
                    <p className="text-secondary">No billing contact yet.</p>
                  )}
                  <p className="field__hint">
                    Owners and Billing admins can change the billing contact.
                  </p>
                </div>
              )}
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
