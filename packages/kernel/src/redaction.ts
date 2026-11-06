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
  '*.password',
  '*.token',
  '*.secret',
  '*.email',
  'body',
  'req.body',
];

/** Mask an email for operational messages: `a***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
