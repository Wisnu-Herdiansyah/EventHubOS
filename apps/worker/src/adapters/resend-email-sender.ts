import type { EmailMessage, EmailSender } from '@eventhub/kernel';

/**
 * Resend adapter (ADR-0008). Calls the HTTP API directly rather than through the `resend` SDK:
 * the SDK prints raw API errors with console.error outside production (bypassing log
 * redaction), and a direct call gives explicit timeouts and error classification.
 *
 * API facts (verified against the official `resend` SDK 6.34.1 source, as the documentation
 * host is unreachable from the build environment): POST {base}/emails, `Authorization: Bearer`,
 * JSON body with `from`, `to`, `subject`, `text`, `tags[{name,value}]`; optional
 * `Idempotency-Key` header; success `{ id }`; errors `{ statusCode, name, message }`.
 */
export interface ResendOptions {
  apiKey: string;
  from: string;
  baseUrl: string;
  timeoutMs: number;
  /** Injectable for contract tests against a local fake server. */
  fetch?: typeof fetch;
}

/** Provider error codes after which retrying the same request can succeed. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'concurrent_idempotent_requests',
  'application_error',
  'internal_server_error',
]);

/**
 * Delivery failure. The message carries only the provider error code and HTTP status, never the
 * provider's free-text message (it can echo recipient addresses) or anything from the request.
 */
export class EmailDeliveryError extends Error {
  readonly provider = 'resend';
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: string, status: number | null, retryable: boolean) {
    super(
      `resend delivery failed: ${code}${status === null ? '' : ` (HTTP ${status})`}${retryable ? ', retryable' : ''}`,
    );
    this.name = 'EmailDeliveryError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const SAFE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TAG_VALUE_RE = /[^A-Za-z0-9_-]/g;

export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';
  readonly #options: ResendOptions;
  readonly #fetch: typeof fetch;

  constructor(options: ResendOptions) {
    this.#options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
    this.#fetch = options.fetch ?? fetch;
  }

  async send(message: EmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#options.apiKey}`,
          'content-type': 'application/json',
          'user-agent': 'eventhub-os-worker',
          // Stable per domain event: a retried delivery of the same event is deduplicated
          // by Resend instead of sending a second email.
          'idempotency-key': message.messageId,
        },
        body: JSON.stringify({
          from: this.#options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          tags: [
            { name: 'template', value: message.template.replace(TAG_VALUE_RE, '_').slice(0, 256) },
          ],
        }),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new EmailDeliveryError(timedOut ? 'timeout' : 'network_error', null, true);
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof body?.id !== 'string' || body.id.length === 0) {
        throw new EmailDeliveryError('malformed_success_response', response.status, true);
      }
      return;
    }

    const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
    const code =
      typeof body?.name === 'string' && SAFE_CODE_RE.test(body.name)
        ? body.name
        : `http_${response.status}`;
    const retryable =
      response.status === 429 || response.status >= 500 || RETRYABLE_CODES.has(code);
    throw new EmailDeliveryError(code, response.status, retryable);
  }
}
