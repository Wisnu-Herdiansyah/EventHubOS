import type { Metadata } from 'next';
import { GrantSupportAccessForm, RevokeSupportAccessDialog } from '@/components/support-access';
import { DownloadAlertsForm } from '@/components/notification-settings';
import { formatInZone } from '@/lib/time';
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

const ALWAYS_SENT: Record<string, string> = {
  security_settings: 'When someone changes the two-step verification requirement',
  support_access: 'When EventHub support access is turned on or off',
  two_step_reminder: 'Reminders to set up two-step verification, while you need it',
};

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  let org, mfa, members, support, notices;
  try {
    const client = await api();
    org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      }),
    );
    // ADR-0049: the person's own email settings (members only; support has none).
    if (!org.mfaSetupRequired && org.role !== 'support') {
      notices = unwrap(
        await client.GET('/v1/organizations/{organizationId}/notification-settings', {
          params: { path: { organizationId: orgId } },
        }),
      );
    }
    if (settingsAbilities(org.role).canEditProfile && !org.mfaSetupRequired) {
      mfa = unwrap(await client.GET('/v1/auth/mfa'));
      // ADR-0025: who the requirement would hold out (membership.manage sees two-step status).
      members = unwrap(
        await client.GET('/v1/organizations/{organizationId}/members', {
          params: { path: { organizationId: orgId } },
        }),
      ).data;
      // ADR-0045: whether EventHub support may view the organization.
      support = unwrap(
        await client.GET('/v1/organizations/{organizationId}/support-access', {
          params: { path: { organizationId: orgId } },
        }),
      );
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

          {abilities.canEditProfile && support ? (
            <Card
              title="Support access"
              titleId="support-heading"
              description="Let EventHub support look at your organization when you ask them for help."
            >
              {support.active ? (
                <div className="stack-sm">
                  <p>
                    <strong>On</strong>
                    {` until ${formatInZone(support.active.expiresAt, org.timezone)}.`}
                  </p>
                  <div>
                    <RevokeSupportAccessDialog
                      organizationId={orgId}
                      idempotencyKey={newIdempotencyKey()}
                    />
                  </div>
                </div>
              ) : (
                <GrantSupportAccessForm
                  organizationId={orgId}
                  idempotencyKey={newIdempotencyKey()}
                />
              )}
              <p className="field__hint">
                Support can read settings, the team, events, reports and the audit log. They cannot
                change anything or see attendee details, and every page they open is in your audit
                log. Owners are emailed when access is turned on or off.
              </p>
            </Card>
          ) : null}

          {notices && (notices.settings.length > 0 || notices.alwaysSent.length > 0) ? (
            <Card
              title="Email notifications"
              titleId="notifications-heading"
              description="Your own choices for this organization. Other people choose for themselves."
            >
              <div className="stack">
                {notices.settings.some((n) => n.kind === 'data_download') ? (
                  <DownloadAlertsForm
                    organizationId={orgId}
                    idempotencyKey={newIdempotencyKey()}
                    enabled={notices.settings.find((n) => n.kind === 'data_download')!.enabled}
                  />
                ) : null}
                {notices.alwaysSent.length > 0 ? (
                  <div className="stack-sm">
                    <p>
                      <strong>Always sent to you</strong>
                    </p>
                    <ul className="bullets">
                      {notices.alwaysSent.map((k) => (
                        <li key={k}>{ALWAYS_SENT[k]}</li>
                      ))}
                    </ul>
                    <p className="field__hint">
                      These are security notices. They can’t be turned off, so nobody can weaken the
                      organization’s protection quietly.
                    </p>
                  </div>
                ) : null}
              </div>
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
