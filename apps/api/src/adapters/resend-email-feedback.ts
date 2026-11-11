import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WebhookRejected, type EmailFeedback, type EmailFeedbackReceiver } from '@eventhub/kernel';

/**
 * Resend delivery webhooks (ADR-0043). Signed with the Standard Webhooks scheme (Svix):
 * base64 HMAC-SHA256 under the `whsec_` secret of `{id}.{timestamp}.{raw body}`, sent as
 * `v1,<signature>` (several may be listed, space-separated, during secret rotation), with a
 * 5-minute timestamp tolerance against replay.
 *
 * Verified against the official `resend` SDK 6.34.1 (its `webhooks.verify` delegates to
 * `standardwebhooks` 1.1.1; event payload types `EmailBouncedEvent`, `EmailComplainedEvent`,
 * `EmailDeliveredEvent`: `{ type, created_at, data: { email_id, to: string[] } }`). Headers are
 * read as `webhook-*` or `svix-*`, which carry the same values. The tests check this verifier
 * against the reference library. Not yet checked against a live delivery: see ADR-0043.
 */
const TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = 'whsec_'; // pragma: allowlist secret
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,253}$/;

const KINDS: Readonly<Record<string, EmailFeedback['kind']>> = {
  'email.bounced': 'bounce',
  'email.complained': 'complaint',
  'email.delivered': 'delivered',
};

const payloadSchema = z.object({
  type: z.string().max(100),
  created_at: z.string().max(64),
  data: z.object({
    email_id: z.string().min(1).max(200),
    to: z.array(z.string().max(320)).min(1).max(50),
  }),
});

/** Decodes a `whsec_` secret; throws for anything too short to be one. */
export function decodeWebhookSecret(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(raw, 'base64');
  if (key.length < 16) throw new Error('Webhook secret must be at least 16 bytes, base64');
  return key;
}

export class ResendEmailFeedbackReceiver implements EmailFeedbackReceiver {
  readonly name = 'resend';
  readonly #key: Buffer;

  constructor(secret: string) {
    this.#key = decodeWebhookSecret(secret);
  }

  parse(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
    now: Date,
  ): EmailFeedback | null {
    const header = (name: string) => headers[`webhook-${name}`] ?? headers[`svix-${name}`];
    const id = header('id');
    const timestamp = header('timestamp');
    const signatures = header('signature');
    if (!id || !timestamp || !signatures || !ID_RE.test(id) || !/^\d{1,12}$/.test(timestamp)) {
      throw new WebhookRejected('signature');
    }
    const sentAt = Number(timestamp);
    if (Math.abs(Math.floor(now.getTime() / 1000) - sentAt) > TOLERANCE_SECONDS) {
      throw new WebhookRejected('timestamp');
    }
    const expected = createHmac('sha256', this.#key)
      .update(`${id}.${timestamp}.${rawBody}`)
      .digest();
    const matches = signatures.split(' ').some((versioned) => {
      const [version, value] = versioned.split(',');
      if (version !== 'v1' || !value) return false;
      const given = Buffer.from(value, 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!matches) throw new WebhookRejected('signature');

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WebhookRejected('malformed');
    }
    const kindOf = (json as { type?: unknown } | null)?.type;
    const kind = typeof kindOf === 'string' ? KINDS[kindOf] : undefined;
    if (!kind) {
      if (typeof kindOf !== 'string') throw new WebhookRejected('malformed');
      return null;
    }
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) throw new WebhookRejected('malformed');
    const recipients = parsed.data.data.to.map((a) => a.trim().toLowerCase());
    if (!recipients.every((a) => EMAIL_RE.test(a))) throw new WebhookRejected('malformed');
    const occurredAt = new Date(parsed.data.created_at);
    return {
      eventId: id,
      kind,
      recipients: [...new Set(recipients)],
      providerMessageId: parsed.data.data.email_id,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? now : occurredAt,
    };
  }
}
