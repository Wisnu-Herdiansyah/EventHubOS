import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { emailFeedbackContract } from '@eventhub/kernel/testing';
import {
  decodeWebhookSecret,
  ResendEmailFeedbackReceiver,
} from './adapters/resend-email-feedback.ts';

// Test-only secrets generated per run.
const secret = `whsec_${randomBytes(24).toString('base64')}`;
const otherSecret = `whsec_${randomBytes(24).toString('base64')}`;

const TYPES = {
  bounce: 'email.bounced',
  complaint: 'email.complained',
  delivered: 'email.delivered',
  other: 'email.opened',
} as const;

/** A payload shaped like the SDK's EmailBouncedEvent and friends. */
function body(type: keyof typeof TYPES, to: string[], messageId: string, at = new Date()) {
  return JSON.stringify({
    type: TYPES[type],
    created_at: at.toISOString(),
    data: {
      created_at: at.toISOString(),
      email_id: messageId,
      message_id: `<${messageId}@example.test>`,
      from: 'EventHub <no-reply@example.test>',
      to,
      subject: 'Subject',
      ...(type === 'bounce'
        ? { bounce: { message: 'Mailbox does not exist', subType: 'General', type: 'Permanent' } }
        : {}),
    },
  });
}

/** Signs as the reference Standard Webhooks library does. */
function sign(raw: string, sentAt: Date, key = secret) {
  const id = `msg_${randomUUID().replace(/-/g, '')}`;
  const signature = new Webhook(key).sign(id, sentAt, raw);
  return {
    'svix-id': id,
    'svix-timestamp': String(Math.floor(sentAt.getTime() / 1000)),
    'svix-signature': signature,
  };
}

emailFeedbackContract('resend', () =>
  Promise.resolve({
    receiver: new ResendEmailFeedbackReceiver(secret),
    delivery: (e, sentAt) => {
      const raw = body(e.type, e.to, e.messageId, sentAt);
      return { body: raw, headers: sign(raw, sentAt) };
    },
    forged: (raw, sentAt) => sign(raw, sentAt, otherSecret),
  }),
);

describe('Resend webhook receiver (ADR-0043)', () => {
  const receiver = new ResendEmailFeedbackReceiver(secret);
  const now = new Date();

  it('agrees with the reference library on what it accepts', () => {
    const raw = body('bounce', ['a@example.test'], 'e1');
    const headers = sign(raw, now);
    // The reference verifies the same delivery (it reads webhook-* names).
    expect(() =>
      new Webhook(secret).verify(raw, {
        'webhook-id': headers['svix-id'],
        'webhook-timestamp': headers['svix-timestamp'],
        'webhook-signature': headers['svix-signature'],
      }),
    ).not.toThrow();
    expect(receiver.parse(raw, headers, now)?.kind).toBe('bounce');
    // Standard Webhooks header names work too.
    expect(
      receiver.parse(
        raw,
        {
          'webhook-id': headers['svix-id'],
          'webhook-timestamp': headers['svix-timestamp'],
          'webhook-signature': headers['svix-signature'],
        },
        now,
      )?.kind,
    ).toBe('bounce');
  });

  it('accepts any listed v1 signature (secret rotation) and ignores other versions', () => {
    const raw = body('complaint', ['a@example.test'], 'e2');
    const h = sign(raw, now);
    const stale = sign(raw, now, otherSecret)['svix-signature'];
    const rotated = { ...h, 'svix-signature': `v2,abc ${stale} ${h['svix-signature']}` };
    expect(receiver.parse(raw, rotated, now)?.kind).toBe('complaint');
    const v2only = { ...h, 'svix-signature': h['svix-signature'].replace('v1,', 'v2,') };
    expect(() => receiver.parse(raw, v2only, now)).toThrow(/signature/);
  });

  it('refuses malformed payloads even when signed, and odd headers', () => {
    const signed = (raw: string) => receiver.parse(raw, sign(raw, now), now);
    expect(() => signed('not json')).toThrow(/malformed/);
    expect(() =>
      signed(JSON.stringify({ type: 'email.bounced', created_at: 'x', data: {} })),
    ).toThrow(/malformed/);
    expect(() => signed(body('bounce', ['not-an-address'], 'e'))).toThrow(/malformed/);
    expect(() => signed(body('bounce', [], 'e'))).toThrow(/malformed/);
    expect(() => signed(JSON.stringify({ data: {} }))).toThrow(/malformed/);
    const raw = body('bounce', ['a@example.test'], 'e');
    const h = sign(raw, now);
    expect(() => receiver.parse(raw, { ...h, 'svix-id': 'bad id with spaces' }, now)).toThrow(
      /signature/,
    );
    expect(() => receiver.parse(raw, { ...h, 'svix-timestamp': '1e9' }, now)).toThrow(/signature/);
  });

  it('dedupes recipients and keeps the provider IDs', () => {
    const raw = body('bounce', ['A@example.test', 'a@example.test ', 'b@example.test'], 'email-9');
    const h = sign(raw, now);
    expect(receiver.parse(raw, h, now)).toMatchObject({
      eventId: h['svix-id'],
      recipients: ['a@example.test', 'b@example.test'],
      providerMessageId: 'email-9',
    });
  });

  it('decodes whsec_ secrets and refuses short ones', () => {
    expect(decodeWebhookSecret(secret)).toHaveLength(24);
    expect(() => decodeWebhookSecret('whsec_c2hvcnQ=')).toThrow();
    // A signature made with the raw key bytes matches what the receiver computes.
    const raw = body('delivered', ['a@example.test'], 'e');
    const id = 'msg_1';
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = createHmac('sha256', decodeWebhookSecret(secret))
      .update(`${id}.${ts}.${raw}`)
      .digest('base64');
    expect(
      receiver.parse(
        raw,
        { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` },
        now,
      )?.kind,
    ).toBe('delivered');
  });
});
