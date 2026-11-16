import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * A visitor's address, vouched for by one of our own web apps (ADR-0058).
 *
 * The admin and site apps call the API from a platform with no fixed addresses, so the API cannot
 * decide by address whose `X-Forwarded-For` to believe. Instead the app signs the visitor's
 * address with a key only the apps and the API hold. The API uses the address for per-visitor
 * rate limits only when the signature is valid and recent.
 */
export const VISITOR_ADDRESS_HEADER = 'x-eventhub-visitor';

/** How old a signed address may be, and how far ahead its clock may run. */
export const VISITOR_ADDRESS_MAX_AGE_SECONDS = 120;

/** The shortest key accepted, in characters. */
export const VISITOR_ADDRESS_KEY_MIN_LENGTH = 32;

const VERSION = 'v1';
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const mac = (key: string, issuedAt: number, address: string) =>
  createHmac('sha256', key).update(`${VERSION}\n${issuedAt}\n${address}`).digest('base64url');

/** The header value for an address, or undefined when it is not an IP address. */
export function signVisitorAddress(
  key: string,
  address: string,
  now: Date = new Date(),
): string | undefined {
  if (!isIP(address)) return undefined;
  const normal = address.toLowerCase();
  const issuedAt = seconds(now);
  return `${VERSION},${issuedAt},${normal},${mac(key, issuedAt, normal)}`;
}

/** The vouched-for address, or null for anything missing, malformed, forged or stale. */
export function verifyVisitorAddress(
  key: string,
  header: unknown,
  now: Date = new Date(),
): string | null {
  if (typeof header !== 'string' || header.length > 160) return null;
  const parts = header.split(',');
  if (parts.length !== 4) return null;
  const [version, issued, address, signature] = parts as [string, string, string, string];
  if (version !== VERSION || !/^\d{1,12}$/.test(issued) || !isIP(address)) return null;
  const issuedAt = Number(issued);
  if (Math.abs(seconds(now) - issuedAt) > VISITOR_ADDRESS_MAX_AGE_SECONDS) return null;
  const expected = Buffer.from(mac(key, issuedAt, address));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return address;
}
