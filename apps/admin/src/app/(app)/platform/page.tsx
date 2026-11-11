import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LiftBounceForm } from '@/components/support-access';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Platform' };

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** EventHub staff tools (ADR-0045): organizations, support access, email delivery. */
export default async function PlatformPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const address = typeof sp.address === 'string' ? sp.address.trim().slice(0, 320) : '';
  let status, orgs, suppression;
  let lookedUp = false;
  try {
    const client = await api();
    status = unwrap(await client.GET('/v1/platform/me'));
    if (!status.staff) notFound();
    if (status.mfaEnabled) {
      orgs = unwrap(await client.GET('/v1/platform/organizations')).data;
      if (address && EMAIL.test(address)) {
        lookedUp = true;
        const r = await client.GET('/v1/platform/email-suppressions', {
          params: { query: { address } },
        });
        suppression = r.response.status === 404 ? null : unwrap(r);
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) notFound();
    signInOn401(error, '/platform');
  }

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[{ label: 'Organizations', href: '/' }, { label: 'Platform' }]}
        eyebrow="EventHub staff"
        title="Platform"
        description="Organizations on EventHub OS, support access they have granted, and email delivery."
      />
      {!status.mfaEnabled || !orgs ? (
        <Notice tone="warning">
          Platform tools need two-step verification.{' '}
          <Link href="/account#two-step-heading">Turn it on in your account</Link>.
        </Notice>
      ) : (
        <>
          <Card flush title="Organizations" titleId="platform-orgs-heading">
            <DataTable
              caption="Organizations"
              rows={orgs}
              rowKey={(o) => o.id}
              columns={[
                {
                  key: 'name',
                  header: 'Organization',
                  lead: true,
                  cell: (o) =>
                    o.supportAccessUntil ? (
                      <Link href={`/orgs/${o.id}`} className="table__primary">
                        {o.displayName}
                      </Link>
                    ) : (
                      <span className="table__primary">{o.displayName}</span>
                    ),
                },
                { key: 'handle', header: 'Public address', cell: (o) => o.publicHandle ?? '–' },
                { key: 'status', header: 'Status', cell: (o) => o.status },
                { key: 'members', header: 'Members', align: 'num', cell: (o) => o.members },
                { key: 'events', header: 'Events', align: 'num', cell: (o) => o.events },
                {
                  key: 'support',
                  header: 'Support access',
                  cell: (o) =>
                    o.supportAccessUntil ? (
                      <Badge tone="success" dot>
                        {`Until ${formatInZone(o.supportAccessUntil, 'UTC')} UTC`}
                      </Badge>
                    ) : (
                      <span className="text-secondary">Not granted</span>
                    ),
                },
              ]}
            />
            <p className="card__note text-secondary">
              You can open an organization only while it grants support access. Everything you open
              there is recorded in its audit log.
            </p>
          </Card>

          <Card
            title="Email delivery"
            titleId="email-delivery-heading"
            description="Why someone does not receive EventHub emails (bounces and spam complaints)."
          >
            <form method="get" className="cluster" role="search" aria-label="Email address">
              <div className="field">
                <label className="field__label" htmlFor="lookup-address">
                  Email address
                </label>
                <input
                  id="lookup-address"
                  name="address"
                  type="email"
                  className="input"
                  defaultValue={address}
                  autoComplete="off"
                />
              </div>
              <div>
                <button type="submit" className="btn btn--secondary">
                  Look up
                </button>
              </div>
            </form>
            {!lookedUp ? null : !suppression ? (
              <p role="status">Nothing blocks email to this address.</p>
            ) : (
              <div className="stack-sm" role="status">
                <p>
                  {suppression.reason === 'complaint'
                    ? 'This person marked an EventHub email as spam. Only emails they ask for themselves (password reset, sign-up confirmations) are sent. Complaints are not lifted by staff.'
                    : suppression.liftedAt
                      ? `This address bounced, but the bounce was lifted on ${formatInZone(suppression.liftedAt, 'UTC')} UTC.`
                      : `Email to this address bounced (last ${formatInZone(suppression.lastEventAt, 'UTC')} UTC). Lift it once the person has fixed their mailbox.`}
                </p>
                {suppression.reason === 'bounce' && !suppression.liftedAt ? (
                  <LiftBounceForm address={address} idempotencyKey={newIdempotencyKey()} />
                ) : null}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
