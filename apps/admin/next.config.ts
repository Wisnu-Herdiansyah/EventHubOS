import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Security headers that do not depend on the request live here. The per-request nonce-based CSP
 * is set in src/proxy.ts.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Container images (ADR-0053) set NEXT_OUTPUT=standalone: a traced, self-contained server.
  // Local development and the e2e harness keep the normal output and `next start`.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? {
        output: 'standalone' as const,
        outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
      }
    : {}),
  reactStrictMode: true,
  // Workspace packages ship TypeScript source (e.g. the shared permission catalog).
  transpilePackages: ['@eventhub/kernel', '@eventhub/microsite'],
  // Image uploads (ADR-0042) go through a server action: 8 MB files plus form overhead.
  experimental: { serverActions: { bodySizeLimit: '9mb' } },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=(), payment=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ]);
  },
};

export default nextConfig;
