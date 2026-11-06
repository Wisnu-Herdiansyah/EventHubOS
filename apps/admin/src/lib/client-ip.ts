import { isIP } from 'node:net';

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
