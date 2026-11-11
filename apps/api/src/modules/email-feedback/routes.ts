import { z } from 'zod';
import { AppError, WebhookRejected, type EmailFeedbackReceiver } from '@eventhub/kernel';
import { withTransaction, type Pool } from '@eventhub/db';
import { definePublicRoute, type AnyRoute } from '../../http/route.ts';

/**
 * Delivery feedback from the email provider (ADR-0043). The provider calls this with a signed
 * webhook; the receiver adapter checks the signature (and its age) over the exact bytes sent,
 * then maps the event. Bounces and complaints put the addresses on the suppression list; a
 * delivery lifts an earlier bounce. A retried delivery of the same event changes nothing.
 *
 * Off (404, like any unknown route) until the webhook secret is configured.
 */
const MAX_BODY = 256 * 1024;

export function emailFeedbackRoutes(
  pool: Pool,
  receiver: EmailFeedbackReceiver | null,
): AnyRoute[] {
  return [
    definePublicRoute({
      method: 'POST',
      path: '/v1/webhooks/email-feedback',
      operationId: 'receiveEmailFeedback',
      summary:
        "The email provider's signed delivery webhook (bounces, complaints, deliveries). Answers 204 when accepted or ignored, 401 for a bad or stale signature.",
      tags: ['webhooks'],
      idempotent: false,
      idempotencyExempt:
        "The provider's event ID is recorded once; a retried delivery of the same event is a no-op.",
      rateLimit: { max: 600, timeWindow: '1 minute' },
      bodyLimit: MAX_BODY,
      rawBody: true,
      schemas: { body: z.string().max(MAX_BODY), response: { status: 204 } },
      async handler({ body, headers }) {
        if (!receiver) throw new AppError('not_found', 'Route not found.');
        let feedback;
        try {
          feedback = receiver.parse(body, headers, new Date());
        } catch (error) {
          if (error instanceof WebhookRejected) {
            throw error.reason === 'malformed'
              ? new AppError('validation_failed', 'Unrecognised webhook payload.')
              : new AppError('unauthenticated', 'Invalid or expired webhook signature.', {
                  details: { reason: `webhook_${error.reason}` },
                });
          }
          throw error;
        }
        if (!feedback) return { status: 204, body: null };
        const f = feedback;
        await withTransaction(pool, {}, (client) =>
          client.query('SELECT eventhub.record_email_feedback($1, $2, $3, $4, $5, $6)', [
            receiver.name,
            f.eventId,
            f.kind,
            f.providerMessageId,
            f.occurredAt,
            f.recipients,
          ]),
        );
        return { status: 204, body: null };
      },
    }),
  ];
}
