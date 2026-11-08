import 'server-only';
import { z } from 'zod';

/**
 * Server-side configuration for the admin app. Validated on first use and fails closed. Nothing
 * here is exposed to the browser: the API base URL and session token stay on the server.
 */
const schema = z.object({
  ADMIN_API_URL: z.url({ protocol: /^https?$/ }),
  /** Public origin of this app, e.g. https://admin.example.com (enables HTTPS-only CSP rules). */
  ADMIN_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * Number of trusted reverse proxies (load balancer, CDN) in front of this app. Used to read the
   * real client IP from X-Forwarded-For; 0 means none, and no client IP is forwarded to the API.
   */
  ADMIN_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * Serves the component gallery at /design-system. On by default outside production builds;
   * set to 1 to show it in a production build (e.g. the e2e harness), 0 to hide it anywhere.
   */
  ADMIN_DESIGN_GALLERY: z.enum(['0', '1']).optional(),
  /**
   * Public site address with a {handle} placeholder, e.g. https://{handle}.eventhub.example
   * (ADR-0021). Optional: without it the admin shows handles but no links.
   */
  ADMIN_PUBLIC_SITE_URL: z
    .string()
    .regex(/^https?:\/\/\{handle\}\.[a-z0-9.-]+(:\d+)?$/i, 'e.g. https://{handle}.eventhub.example')
    .optional(),
});

export interface AdminConfig {
  apiUrl: string;
  trustedProxyHops: number;
  designGallery: boolean;
  publicSiteUrl: string | null;
}

/** The gallery is on in development unless switched off, and off in production unless on. */
export function galleryEnabled(flag: '0' | '1' | undefined, nodeEnv: string | undefined): boolean {
  return flag === undefined ? nodeEnv !== 'production' : flag === '1';
}

let cached: AdminConfig | null = null;

export function adminConfig(): AdminConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid admin configuration: ${keys.join(', ')}`);
  }
  cached = {
    apiUrl: parsed.data.ADMIN_API_URL.replace(/\/+$/, ''),
    trustedProxyHops: parsed.data.ADMIN_TRUSTED_PROXY_HOPS,
    designGallery: galleryEnabled(parsed.data.ADMIN_DESIGN_GALLERY, process.env.NODE_ENV),
    publicSiteUrl: parsed.data.ADMIN_PUBLIC_SITE_URL ?? null,
  };
  return cached;
}
