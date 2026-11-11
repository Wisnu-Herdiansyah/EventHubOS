import type { Pool } from '@eventhub/db';
import type { EmailMessage, EmailSender } from '@eventhub/kernel';
import { maySend, type SuppressionReason } from '../email-policy.ts';

/**
 * Looks up an address's suppression through its own pool. It must not share the outbox pool:
 * the consumer sending the email already holds a connection from that pool inside its
 * transaction, so a lookup there could wait forever for a free connection.
 */
export function suppressionLookup(pool: Pool) {
  return async (address: string): Promise<SuppressionReason | null> => {
    const { rows } = await pool.query<{ reason: SuppressionReason | null }>(
      'SELECT eventhub.email_suppression_reason($1) AS reason',
      [address],
    );
    return rows[0]?.reason ?? null;
  };
}

export interface SuppressionLog {
  info(fields: Record<string, unknown>, message: string): void;
}

/**
 * Wraps the real sender (ADR-0043): before each email, looks up whether the address bounced or
 * complained, and skips what the policy says not to send. A skipped email counts as handled, so
 * the outbox does not retry it. Logs the template and reason only, never the address.
 */
export class SuppressingEmailSender implements EmailSender {
  readonly name: string;
  readonly #inner: EmailSender;
  readonly #reasonFor: (address: string) => Promise<SuppressionReason | null>;
  readonly #log: SuppressionLog | undefined;

  constructor(
    inner: EmailSender,
    reasonFor: (address: string) => Promise<SuppressionReason | null>,
    log?: SuppressionLog,
  ) {
    this.name = inner.name;
    this.#inner = inner;
    this.#reasonFor = reasonFor;
    this.#log = log;
  }

  async send(message: EmailMessage): Promise<void> {
    const reason = await this.#reasonFor(message.to);
    if (!maySend(message.template, reason)) {
      this.#log?.info({ template: message.template, reason }, 'email suppressed');
      return;
    }
    await this.#inner.send(message);
  }
}
