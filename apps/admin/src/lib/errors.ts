/**
 * API error handling shared by Server Actions and pages (pure; unit-tested).
 * The API returns `{ error: { code, message, retryable, correlationId, details? } }`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;
  readonly reason: string | null;
  readonly fields: Array<{ path: string; message: string }>;

  constructor(status: number, body: unknown) {
    const e = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
    const details = (e.details ?? {}) as { reason?: unknown; fields?: unknown };
    super(typeof e.message === 'string' ? e.message : `Request failed (HTTP ${status}).`);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof e.code === 'string' ? e.code : 'unknown_error';
    this.correlationId = typeof e.correlationId === 'string' ? e.correlationId : null;
    this.reason = typeof details.reason === 'string' ? details.reason : null;
    this.fields = Array.isArray(details.fields)
      ? (details.fields as unknown[]).flatMap((f) => {
          const x = f as { path?: unknown; message?: unknown };
          return typeof x.path === 'string' && typeof x.message === 'string'
            ? [{ path: x.path, message: x.message }]
            : [];
        })
      : [];
  }
}

/** State returned by Server Actions to forms (`useActionState`). */
export interface FormState {
  ok?: boolean;
  message?: string;
  /** Field errors keyed by form field name (API paths like `body.settings.legal.termsUrl` → `termsUrl`). */
  fields?: Record<string, string>;
  /** Correlation ID to quote to support. */
  reference?: string;
  /** Submitted text to refill the form after a failure (never passwords or tokens). */
  values?: Record<string, string>;
}

export const initialFormState: FormState = {};

/** Maps an API field path to the form input name that produced it (last path segment). */
export function fieldName(path: string): string {
  return path.split('.').pop() ?? path;
}

/** Plain-language messages for API reasons whose own message is too technical for the UI. */
const FRIENDLY_REASONS: Record<string, string> = {
  version_conflict:
    'Someone else changed this while you were editing, so nothing was saved. Reload the page to see the latest version, then make your change again.',
};

export function errorToFormState(error: unknown): FormState {
  if (error instanceof ApiError) {
    const fields: Record<string, string> = {};
    for (const f of error.fields) fields[fieldName(f.path)] ??= f.message;
    const hasFields = Object.keys(fields).length > 0;
    return {
      ok: false,
      // Field errors are shown next to their inputs; the summary points the user there.
      message: hasFields
        ? 'Check the highlighted fields.'
        : (FRIENDLY_REASONS[error.reason ?? ''] ?? error.message),
      ...(hasFields ? { fields } : {}),
      ...(error.correlationId ? { reference: error.correlationId } : {}),
    };
  }
  // Never echo unexpected errors to the browser; they are logged server-side.
  return { ok: false, message: 'Something went wrong. Please try again.' };
}
