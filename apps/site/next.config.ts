import path from 'node:path';
import type { NextConfig } from 'next';

/** Public event sites (ADR-0021). The per-request CSP is set in src/proxy.ts. */
const nextConfig: NextConfig = {
  // Container images (ADR-0053) set NEXT_OUTPUT=standalone: a traced, self-contained server.
  // Local development and the e2e harness keep the normal output and `next start`.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? {
        output: 'standalone' as const,
        outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
      }
    : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@eventhub/microsite'],
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ]);
  },
};

export default nextConfig;
