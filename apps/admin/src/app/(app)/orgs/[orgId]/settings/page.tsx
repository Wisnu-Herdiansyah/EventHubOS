import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BillingContactForm, OrganizationProfileForm } from '@/components/org-forms';
import { Card } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { LOCALES, ROLE_LABELS, timeZones } from '@/lib/options';
import { settingsAbilities } from '@/lib/permissions';

export const metadata: Metadata = { title: 'Organization settings' };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
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
    signInOn401(error, `/orgs/${orgId}/settings`);
  }

  const abilities = settingsAbilities(org.role);
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
