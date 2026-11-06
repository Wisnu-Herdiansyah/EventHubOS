import 'server-only';
import { randomUUID } from 'node:crypto';
import createClient from 'openapi-fetch';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { paths } from './api-types';
import { clientIpFromForwarded } from './client-ip';
import { adminConfig } from './config';
import { ApiError } from './errors';
import { readSessionToken } from './session';

/**
 * Typed API client generated from the OpenAPI contract. Runs only on the server: it attaches the
 * session token from the HttpOnly cookie and, behind a configured proxy, forwards the client IP so
 * the API's per-IP limits apply to the real client (the API must trust this app via TRUST_PROXY).
 */
export async function api() {
  const config = adminConfig();
  const token = await readSessionToken();
  const incoming = await headers();
  const forwarded = clientIpFromForwarded(incoming.get('x-forwarded-for'), config.trustedProxyHops);
  // The browser's own user-agent, so sessions can be named "Firefox on Windows" (ADR-0017).
  // Self-reported and informational only; never used for security decisions.
  const userAgent = incoming.get('user-agent')?.slice(0, 256);
  return createClient<paths>({
    baseUrl: config.apiUrl,
    headers: {
      'x-correlation-id': `admin-${randomUUID()}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    },
  });
}

/** Unwraps an openapi-fetch result, throwing ApiError for any non-2xx response. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.ok) return result.data as T;
  throw new ApiError(result.response.status, result.error);
}

/** For pages: an expired or missing session sends the user to sign in, then back here. */
export function signInOn401(error: unknown, returnTo: string): never {
  if (error instanceof ApiError && error.status === 401) {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }
  throw error;
}

/** Fresh per render: a double-submitted form reuses its key, so the API replays instead of repeating. */
export function newIdempotencyKey(): string {
  return `admin-${randomUUID()}`;
}
