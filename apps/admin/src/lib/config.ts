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
});

export interface AdminConfig {
  apiUrl: string;
  trustedProxyHops: number;
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
  };
  return cached;
}
