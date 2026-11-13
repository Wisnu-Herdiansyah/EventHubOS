/**
 * Structured-log redaction paths (pino syntax). Credentials, session material, and request
 * bodies that may contain PII never reach logs. Extend when new sensitive fields appear.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  // pino's `*` matches exactly one level, so every sensitive field lists each depth it is hidden
  // at: one, two and three levels below the logged object. Deeper nesting is NOT covered.
  '*.password',
  '*.*.password',
  '*.*.*.password',
  '*.token',
  '*.*.token',
  '*.*.*.token',
  '*.secret',
  '*.*.secret',
  '*.*.*.secret',
  // Provider keys held in configuration (ADR-0054) and their request headers.
  '*.secretKey',
  '*.*.secretKey',
  '*.*.*.secretKey',
  '*.apiKey',
  '*.*.apiKey',
  '*.*.*.apiKey',
  'headers.apikey',
  '*.headers.apikey',
  '*.email',
  '*.*.email',
  '*.*.*.email',
  // Email feedback (ADR-0043): recipient addresses from the provider.
  '*.recipients',
  '*.*.recipients',
  '*.*.*.recipients',
  'body',
  'req.body',
];

/** Mask an email for operational messages: `a***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
