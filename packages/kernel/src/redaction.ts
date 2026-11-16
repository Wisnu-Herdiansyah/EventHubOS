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
  // Signed visitor addresses (ADR-0058): replayable for two minutes, so never logged.
  'req.headers["x-eventhub-visitor"]',
  'headers["x-eventhub-visitor"]',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  // Provider keys held in configuration (ADR-0054) and their request headers. pino's `*` matches
  // one level, so nested configuration objects need each depth listed.
  '*.secretKey',
  '*.*.secretKey',
  '*.*.*.secretKey',
  '*.apiKey',
  '*.*.apiKey',
  '*.*.*.apiKey',
  'headers.apikey',
  '*.headers.apikey',
  '*.email',
  // Email feedback (ADR-0043): recipient addresses from the provider.
  '*.recipients',
  'body',
  'req.body',
];

/** Mask an email for operational messages: `a***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export const LOG_CENSOR = '[REDACTED]';

/**
 * Field names whose values never reach logs, at any depth (ADR-0060). Names are compared in
 * lower case with punctuation removed, so `set-cookie`, `setCookie` and `SET_COOKIE` are one name.
 */
const SENSITIVE_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'email',
  'emails',
  'recipients',
  'body',
  'apikey',
  'xapikey',
  'xeventhubvisitor',
  'signature',
  'svixsignature',
  'recoverycodes',
]);
/** Endings that mark a credential whatever it is a credential for: `resetToken`, `MFA_ENCRYPTION_KEY`. */
const SENSITIVE_ENDINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'secretkey',
  'privatekey',
  'encryptionkey',
  'addresskey',
  'credential',
  'credentials',
];

export function isSensitiveLogKey(key: string): boolean {
  const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_NAMES.has(name) || SENSITIVE_ENDINGS.some((ending) => name.endsWith(ending));
}

const MAX_DEPTH = 8;

/**
 * A copy of a value about to be logged, with every sensitive field replaced, however deeply it
 * is nested. Never changes what it is given.
 */
export function redactLogValue(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Error || ArrayBuffer.isView(value)) return value;
  // Dates, and anything else that writes itself as one value, are not walked.
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => walk(item, depth + 1, seen));
  } else {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] =
        isSensitiveLogKey(key) && item !== undefined && item !== null
          ? LOG_CENSOR
          : walk(item, depth + 1, seen);
    }
    out = copy;
  }
  seen.delete(value);
  return out;
}

// Characters that can appear inside a JSON string without ending or escaping it.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s"\\/:@]*):[^\s"\\/@]+@/gi;
const QUERY_SECRET =
  /([?&](?:[a-z0-9_.-]*(?:token|secret|password|signature|api[_-]?key)|code|sig)=)[^&\s"\\#]+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// The last part of the domain must be letters, so `pg-pool@3.14.0` in a stack trace is not an address.
const EMAIL_ADDRESS = /([A-Za-z0-9])[A-Za-z0-9._%+-]*(@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;

/**
 * Removes credentials from a piece of text: the password in a URL, secret query parameters,
 * bearer tokens, and all but the first letter of an email address. Applied to every finished
 * log line, so it also covers messages, error text, stack traces and request URLs. Safe on a
 * line of JSON: it never adds or removes a quote or a backslash.
 */
export function scrubLogText(text: string): string {
  return text
    .replace(URL_CREDENTIALS, `$1:${LOG_CENSOR}@`)
    .replace(QUERY_SECRET, `$1${LOG_CENSOR}`)
    .replace(BEARER, `$1 ${LOG_CENSOR}`)
    .replace(EMAIL_ADDRESS, '$1***$2');
}

/**
 * One finished log line (JSON), redacted: sensitive field names at any depth, then credentials
 * inside any text. Working on the finished line covers everything the logger writes: logged
 * objects, child logger bindings, serialized requests, responses and errors, and the message.
 * A line that is not JSON is still scrubbed as text.
 */
export function redactLogLine(line: string): string {
  let redacted = line;
  try {
    redacted = `${JSON.stringify(redactLogValue(JSON.parse(line)))}\n`;
  } catch {
    // Not JSON (a custom destination or a partial write): the text pass below still applies.
  }
  return scrubLogText(redacted);
}

/**
 * Logger options (pino) for every service (ADR-0060). Two layers:
 *   1. the listed paths, removed by the logger itself;
 *   2. `redactLogLine` on each finished line.
 * The kernel does not depend on the logging library; this is a plain options object.
 */
export function redactingLogOptions() {
  return {
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_CENSOR },
    hooks: { streamWrite: redactLogLine },
  };
}
