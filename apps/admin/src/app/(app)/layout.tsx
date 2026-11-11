import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { logoutAction } from '../actions/auth';
import { AppShell } from '@/components/shell/app-shell';
import { api } from '@/lib/api';
import { navOrganization, type NavOrganization } from '@/lib/navigation';
import { SIDEBAR_COOKIE, parseSidebar } from '@/lib/preferences';
import { readSessionToken } from '@/lib/session';

async function signedInContext(): Promise<{
  email: string;
  orgs: NavOrganization[];
  platform: boolean;
} | null> {
  if (!(await readSessionToken())) return null;
  try {
    const client = await api();
    const [me, orgs, platform] = await Promise.all([
      client.GET('/v1/me'),
      client.GET('/v1/me/organizations'),
      client.GET('/v1/platform/me'),
    ]);
    if (!me.response.ok || !me.data) return null;
    return {
      email: me.data.email,
      orgs: orgs.response.ok && orgs.data ? orgs.data.data.map(navOrganization) : [],
      // EventHub staff see the Platform link (ADR-0045).
      platform: platform.data?.staff === true,
    };
  } catch {
    return null;
  }
}

/**
 * Signed-in pages. When the session is missing or no longer accepted the page itself redirects
 * to sign in; until then the content renders without the shell, so nothing about the account
 * is shown.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await signedInContext();
  if (!ctx) {
    return (
      <main id="main" className="content" tabIndex={-1}>
        {children}
      </main>
    );
  }
  const sidebar = parseSidebar((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return (
    <AppShell
      email={ctx.email}
      organizations={ctx.orgs}
      platform={ctx.platform}
      sidebar={sidebar}
      logout={logoutAction}
    >
      {children}
    </AppShell>
  );
}
