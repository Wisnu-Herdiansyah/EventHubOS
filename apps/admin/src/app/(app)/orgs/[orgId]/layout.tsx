import type { ReactNode } from 'react';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { formatInZone } from '@/lib/time';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Organization pages. For EventHub staff working under support access (ADR-0045), a banner on
 * every page says so: read-only, no attendee details, until when, and that it is recorded.
 * Members see nothing extra. Pages do their own loading and error handling.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  let support: { name: string; until: string } | null = null;
  if (UUID.test(orgId)) {
    try {
      const client = await api();
      const org = await client.GET('/v1/organizations/{organizationId}', {
        params: { path: { organizationId: orgId } },
      });
      if (org.data?.role === 'support' && org.data.supportAccessUntil) {
        support = { name: org.data.displayName, until: org.data.supportAccessUntil };
      }
    } catch {
      // The page shows any error itself.
    }
  }
  return (
    <>
      {support ? (
        <div className="support-banner">
          <Notice tone="warning">
            {`You are viewing ${support.name} as EventHub support, read-only and without attendee details, until ${formatInZone(support.until, 'UTC')} UTC. Every page you open is recorded in their audit log.`}
          </Notice>
        </div>
      ) : null}
      {children}
    </>
  );
}
