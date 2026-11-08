import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { THEME_COOKIE, parseTheme } from '@/lib/preferences';
import '@eventhub/microsite/site.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'EventHub OS', template: '%s · EventHub OS' },
  description: 'Build, publish, and operate event microsites.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5f7' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers keeps every page dynamically rendered, which the per-request CSP
  // nonce requires (Next.js applies the nonce from the request's CSP header to its scripts).
  await headers();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme === 'system' ? undefined : theme}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
