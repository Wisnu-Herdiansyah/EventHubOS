# ADR-0006: API error taxonomy and correlation IDs

- Status: accepted
- Date: 2026-11-06

## Decision

- All errors use one body: `{ error: { code, message, retryable, correlationId, details? } }`
  where `code` is from the closed set in `packages/kernel/src/errors.ts`.
- Unexpected errors return `internal_error` with a generic message; details are logged
  server-side only, keyed by correlation ID. SQL text, stack traces, and config values never
  reach clients.
- Every response carries `X-Correlation-Id`. A client-supplied value is accepted only if it
  matches `^[A-Za-z0-9._:-]{8,128}$`; otherwise the server generates a UUID.
- Inaccessible and non-existent tenant resources both return `404 not_found` (anti-enumeration).
- Logs redact `authorization`, cookies, request bodies, and `*.email|password|token|secret`.
