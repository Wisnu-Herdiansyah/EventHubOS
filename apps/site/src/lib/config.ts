import 'server-only';
import { z } from 'zod';

/** Server-side configuration for the public site. Validated on first use; fails closed. */
const schema = z.object({
  SITE_API_URL: z.url({ protocol: /^https?$/ }),
  /** The platform domain sites live under, e.g. eventhub.example (handles are its subdomains). */
  SITE_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/i, 'A bare domain such as eventhub.example'),
  /** 1 when served over HTTPS (adds upgrade-insecure-requests to the CSP). */
  SITE_HTTPS: z.enum(['0', '1']).default('1'),
});

let cached: { apiUrl: string; domain: string; https: boolean } | null = null;

export function siteConfig() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid site configuration: ${keys.join(', ')}`);
  }
  cached = {
    apiUrl: parsed.data.SITE_API_URL.replace(/\/+$/, ''),
    domain: parsed.data.SITE_DOMAIN.toLowerCase(),
    https: parsed.data.SITE_HTTPS === '1',
  };
  return cached;
}
