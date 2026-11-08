import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import '@eventhub/microsite/site.css';
import './globals.css';

export const metadata: Metadata = {
  // Event pages opt in to indexing; everything else stays out of search results.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Dynamic rendering, so Next.js applies the per-request CSP nonce to its scripts.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
