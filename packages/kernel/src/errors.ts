/**
 * Error taxonomy. Every error that crosses the API boundary is an AppError with a stable
 * machine-readable code. Unknown errors are mapped to `internal_error` with a generic message
 * so that internals, SQL, and secrets never reach clients.
 */

export const ERROR_DEFINITIONS = {
  validation_failed: { status: 400, retryable: false },
  idempotency_key_required: { status: 400, retryable: false },
  unauthenticated: { status: 401, retryable: false },
  email_not_verified: { status: 403, retryable: false },
  forbidden: { status: 403, retryable: false },
  not_found: { status: 404, retryable: false },
  conflict: { status: 409, retryable: false },
  idempotency_key_reused: { status: 422, retryable: false },
  payload_too_large: { status: 413, retryable: false },
  unsupported_media_type: { status: 415, retryable: false },
  rate_limited: { status: 429, retryable: true },
  internal_error: { status: 500, retryable: true },
  service_unavailable: { status: 503, retryable: true },
} as const satisfies Record<string, { status: number; retryable: boolean }>;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export interface FieldIssue {
  path: string;
  message: string;
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    correlationId: string;
    details?: { reason?: string; fields?: FieldIssue[] };
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: { reason?: string; fields?: FieldIssue[] } | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: { reason?: string; fields?: FieldIssue[] }; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_DEFINITIONS[code].status;
    this.retryable = ERROR_DEFINITIONS[code].retryable;
    this.details = options.details;
  }

  toBody(correlationId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        correlationId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function internalErrorBody(correlationId: string): ErrorBody {
  return new AppError(
    'internal_error',
    'An unexpected error occurred. Quote the correlation ID when contacting support.',
  ).toBody(correlationId);
}

/** Uniform "not found" used for both absent and inaccessible resources to avoid enumeration. */
export function notFound(resource: string): AppError {
  return new AppError('not_found', `${resource} not found.`);
}
