import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BillingContactForm, OrganizationProfileForm } from '@/components/org-forms';
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
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">Organizations</Link>
          </li>
          <li>
            <Link href={`/orgs/${orgId}`}>{org.displayName}</Link>
          </li>
          <li aria-current="page">Settings</li>
        </ol>
      </nav>
      <div className="page-head">
        <div>
          <p className="eyebrow">{org.displayName}</p>
          <h1>Settings</h1>
          <p className="muted">Your role: {ROLE_LABELS[org.role] ?? org.role}</p>
        </div>
      </div>

      {!abilities.canOpen ? (
        <div className="message info" role="status">
          Only Owners, Admins and Billing admins can see organization settings.
        </div>
      ) : (
        <div className="grid">
          <section className="card accent" aria-labelledby="profile-heading">
            <h2 id="profile-heading">Profile</h2>
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
              <>
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
                <p className="muted">Owners and Admins can change the profile.</p>
              </>
            )}
          </section>

          {abilities.canReadBilling || abilities.canEditBilling ? (
            <section className="card" aria-labelledby="billing-heading">
              <h2 id="billing-heading">Billing contact</h2>
              {abilities.canEditBilling ? (
                <BillingContactForm
                  organizationId={orgId}
                  version={org.version}
                  idempotencyKey={newIdempotencyKey()}
                  defaults={{ name: billing?.name ?? '', email: billing?.email ?? '' }}
                />
              ) : (
                <>
                  {billing?.name && billing.email ? (
                    <dl className="details">
                      <dt>Name</dt>
                      <dd>{billing.name}</dd>
                      <dt>Email</dt>
                      <dd>{billing.email}</dd>
                    </dl>
                  ) : (
                    <p className="muted">No billing contact yet.</p>
                  )}
                  <p className="muted">Owners and Billing admins can change the billing contact.</p>
                </>
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
