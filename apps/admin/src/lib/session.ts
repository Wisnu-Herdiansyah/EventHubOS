import 'server-only';
import { cookies } from 'next/headers';

/**
 * The API session token lives only in this HttpOnly cookie. Browser JavaScript can never read it;
 * the Next.js server attaches it to API calls (backend-for-frontend). The `__Host-` prefix pins
 * the cookie to this exact host over HTTPS with Path=/ and no Domain attribute. Browsers treat
 * http://localhost as a secure context, so local and test runs work too.
 */
export const SESSION_COOKIE = '__Host-eventhub_session';

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Only callable from Server Actions or Route Handlers. */
export async function writeSession(token: string, expiresAt: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
