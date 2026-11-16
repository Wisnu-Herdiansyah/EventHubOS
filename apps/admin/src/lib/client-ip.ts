import { isIP } from 'node:net';
import { VISITOR_ADDRESS_HEADER, signVisitorAddress } from '@eventhub/kernel/visitor-address';

/**
 * Picks the client address from X-Forwarded-For without trusting anything the client wrote.
 *
 * Each trusted proxy in front of this app appends the address it received the connection from, so
 * with `hops` trusted proxies the real client is the `hops`-th entry from the right. Entries further
 * left are client-supplied and ignored. With `hops = 0` (no proxy configured) nothing is returned:
 * Next.js passes a client-sent header through unchanged, so it cannot be believed.
 */
export function clientIpFromForwarded(header: string | null, hops: number): string | undefined {
  if (!header || hops < 1) return undefined;
  const entries = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const candidate = entries[entries.length - hops];
  return candidate && isIP(candidate) ? candidate : undefined;
}

/**
 * Headers that tell the API which visitor a call is for, so its per-visitor limits apply to the
 * real visitor and not to this app. `X-Forwarded-For` is believed only by an API that lists this
 * app's address (TRUST_PROXY). With a key, the address is also signed (ADR-0058), which works
 * when this app has no fixed address.
 */
export function visitorHeaders(
  forwardedFor: string | null,
  hops: number,
  key: string | null,
  now: Date = new Date(),
): Record<string, string> {
  const ip = clientIpFromForwarded(forwardedFor, hops);
  if (!ip) return {};
  const signed = key ? signVisitorAddress(key, ip, now) : undefined;
  return {
    'x-forwarded-for': ip,
    ...(signed ? { [VISITOR_ADDRESS_HEADER]: signed } : {}),
  };
}
