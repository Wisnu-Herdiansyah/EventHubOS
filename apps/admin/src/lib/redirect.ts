/**
 * Post-login redirect targets come from the query string, so they must be local paths only.
 * Rejects absolute URLs, protocol-relative `//host`, backslash tricks, and control characters.
 */
export function safeNext(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}
