import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { logoutAction } from './actions/auth';
import { api } from '@/lib/api';
import { readSessionToken } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'EventHub OS', template: '%s · EventHub OS' },
  description: 'Build, publish, and operate event microsites.',
  robots: { index: false, follow: false },
};

async function currentUserEmail(): Promise<string | null> {
  if (!(await readSessionToken())) return null;
  try {
    const client = await api();
    const res = await client.GET('/v1/me');
    return res.response.ok && res.data ? res.data.email : null;
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers keeps every page dynamically rendered, which the per-request CSP
  // nonce requires (Next.js applies the nonce from the request's CSP header to its scripts).
  await headers();
  const email = await currentUserEmail();
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                EH
              </span>
              EventHub OS
            </Link>
            {email ? (
              <div className="account">
                <span className="who">
                  <span className="visually-hidden">Signed in as </span>
                  {email}
                </span>
                <Link href="/account">Account</Link>
                <form action={logoutAction}>
                  <button type="submit" className="link">
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
