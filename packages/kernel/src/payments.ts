import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebhookRejected } from './ports.ts';

/**
 * Paid ticketing (ADR-0070). Each organizer is the seller of their own tickets and has an
 * account with the payment provider; EventHub is a platform that opens checkouts on the
 * organizer's account and takes a platform fee. Launch market: Indonesia, rupiah only.
 *
 * Domain code depends only on this port. The provider adapter (Xendit xenPlatform, ADR-0070)
 * maps its API and webhooks to these shapes, and passes the shared contract in
 * `testing/payment-gateway.contract.ts` against the provider's test mode before it is used.
 * No provider format, credential or secret reaches domain code, logs or error messages.
 */

/** A whole number of rupiah. IDR has no minor unit in practice, so amounts are integers. */
export type Rupiah = number;

/** The most one checkout may charge, as a guard against unit mistakes (amount in sen, etc.). */
export const MAX_CHECKOUT_RUPIAH = 1_000_000_000;

/** Our own order reference, sent to the provider and echoed in its webhooks. */
export const PAYMENT_REFERENCE = /^[a-z0-9][a-z0-9-]{7,63}$/;

/** A request the gateway refuses before calling the provider: a bug in the caller, not input. */
export class InvalidPaymentRequest extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`invalid payment request: ${field}: ${message}`);
    this.name = 'InvalidPaymentRequest';
    this.field = field;
  }
}

/** The organizer's account with the provider, created when they turn on paid tickets. */
export interface SellerAccountRequest {
  /** The organization the account belongs to; one account per organization. */
  organizationId: string;
  /** The organization's name, shown to the provider. */
  businessName: string;
  /** Where the provider sends onboarding and verification email. */
  email: string;
}

export interface SellerAccount {
  providerAccountId: string;
  /** pending: the provider still needs the organizer's details or verification. */
  status: 'pending' | 'active';
}

export interface CheckoutRequest {
  /** One per order. Creating a checkout twice with the same reference returns the first one. */
  reference: string;
  /** The seller: the organizer's provider account. */
  sellerAccountId: string;
  /** What the buyer pays, in whole rupiah. */
  amount: Rupiah;
  /** EventHub's platform fee out of `amount`, in whole rupiah; the rest goes to the seller. */
  platformFee: Rupiah;
  /** Shown to the buyer on the provider's payment page. */
  description: string;
  payerEmail: string;
  /** Where the provider sends the buyer after paying, or after giving up. */
  successUrl: string;
  failureUrl: string;
  /** After this the checkout can no longer be paid. */
  expiresAt: Date;
}

export interface Checkout {
  providerCheckoutId: string;
  /** The provider's payment page for the buyer. */
  paymentUrl: string;
  expiresAt: Date;
}

/** paid: the money was taken; expired: never paid in time; failed: the payment was refused. */
export type PaymentOutcome = 'paid' | 'expired' | 'failed';

export interface PaymentEvent {
  /** The provider's event ID: retried deliveries of one event share it. */
  eventId: string;
  outcome: PaymentOutcome;
  /** Our reference from the checkout. */
  reference: string;
  providerCheckoutId: string;
  /** What was paid (for `paid`), in whole rupiah; checked against the order by the caller. */
  amount: Rupiah;
  occurredAt: Date;
}

export interface PaymentGateway {
  readonly name: string;
  createSellerAccount(request: SellerAccountRequest): Promise<SellerAccount>;
  /** Idempotent per `reference`; a different request under a used reference is refused. */
  createCheckout(request: CheckoutRequest): Promise<Checkout>;
  /**
   * Verifies and parses one webhook delivery. Returns null for event types that carry no
   * payment outcome (acknowledged and ignored). Throws WebhookRejected otherwise.
   */
  parseWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
    now: Date,
  ): PaymentEvent | null;
}

const isRupiah = (n: number) => Number.isSafeInteger(n);
// Plain HTTPS addresses only: the buyer is sent there by the provider.
const isHttpsUrl = (u: string) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Checks a checkout request the same way for every adapter, before any provider call. */
export function assertCheckoutRequest(r: CheckoutRequest): void {
  if (!PAYMENT_REFERENCE.test(r.reference)) {
    throw new InvalidPaymentRequest('reference', 'lowercase letters, digits and dashes, 8-64');
  }
  if (!r.sellerAccountId) throw new InvalidPaymentRequest('sellerAccountId', 'required');
  if (!isRupiah(r.amount) || r.amount < 1 || r.amount > MAX_CHECKOUT_RUPIAH) {
    throw new InvalidPaymentRequest('amount', `whole rupiah from 1 to ${MAX_CHECKOUT_RUPIAH}`);
  }
  if (!isRupiah(r.platformFee) || r.platformFee < 0 || r.platformFee >= r.amount) {
    throw new InvalidPaymentRequest('platformFee', 'whole rupiah, at least 0, below the amount');
  }
  if (!r.description.trim() || r.description.length > 255) {
    throw new InvalidPaymentRequest('description', '1 to 255 characters');
  }
  if (!r.payerEmail.includes('@')) throw new InvalidPaymentRequest('payerEmail', 'an address');
  if (!isHttpsUrl(r.successUrl)) throw new InvalidPaymentRequest('successUrl', 'an https URL');
  if (!isHttpsUrl(r.failureUrl)) throw new InvalidPaymentRequest('failureUrl', 'an https URL');
  if (Number.isNaN(r.expiresAt.getTime())) {
    throw new InvalidPaymentRequest('expiresAt', 'a date');
  }
}

/** How old a signed webhook may be before it is refused as a replay. */
export const PAYMENT_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

const SIGNATURE_HEADER = 'x-in-memory-signature';
const TIMESTAMP_HEADER = 'x-in-memory-timestamp';

/**
 * In-memory gateway: a local/test fake only, never a provider. It keeps checkouts in memory and
 * signs its own webhooks with a test key, so the domain flow and the contract can be exercised
 * without network or credentials. Configuration must refuse it outside local and test.
 */
export class InMemoryPaymentGateway implements PaymentGateway {
  readonly name = 'in_memory';
  readonly #key: string;
  readonly #checkouts = new Map<string, { request: CheckoutRequest; checkout: Checkout }>();
  readonly #accounts = new Map<string, SellerAccount>();

  constructor(signingKey: string) {
    if (signingKey.length < 32) throw new Error('in-memory gateway: signing key too short');
    this.#key = signingKey;
  }

  createSellerAccount(request: SellerAccountRequest): Promise<SellerAccount> {
    const existing = this.#accounts.get(request.organizationId);
    if (existing) return Promise.resolve({ ...existing });
    const account: SellerAccount = { providerAccountId: `acct_${randomUUID()}`, status: 'active' };
    this.#accounts.set(request.organizationId, account);
    return Promise.resolve({ ...account });
  }

  createCheckout(request: CheckoutRequest): Promise<Checkout> {
    try {
      assertCheckoutRequest(request);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const known = this.#checkouts.get(request.reference);
    if (known) {
      const same =
        known.request.sellerAccountId === request.sellerAccountId &&
        known.request.amount === request.amount &&
        known.request.platformFee === request.platformFee;
      if (!same) {
        return Promise.reject(
          new InvalidPaymentRequest('reference', 'already used for a different checkout'),
        );
      }
      return Promise.resolve({ ...known.checkout });
    }
    const id = `chk_${randomUUID()}`;
    const checkout: Checkout = {
      providerCheckoutId: id,
      paymentUrl: `https://payments.example.test/checkout/${id}`,
      expiresAt: request.expiresAt,
    };
    this.#checkouts.set(request.reference, { request: structuredClone(request), checkout });
    return Promise.resolve({ ...checkout });
  }

  /** Test helper: the signed webhook the provider would send for this checkout's outcome. */
  webhookFor(
    reference: string,
    outcome: PaymentOutcome | 'other',
    sentAt: Date,
  ): { body: string; headers: Record<string, string> } {
    const known = this.#checkouts.get(reference);
    if (!known) throw new Error(`in-memory gateway: no checkout ${reference}`);
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: outcome,
      reference,
      checkout_id: known.checkout.providerCheckoutId,
      amount: known.request.amount,
      occurred_at: sentAt.toISOString(),
    });
    return { body, headers: this.#sign(body, sentAt, this.#key) };
  }

  /** Test helper: the same body signed with another key. */
  forge(body: string, sentAt: Date): Record<string, string> {
    return this.#sign(body, sentAt, `forged-${this.#key}`);
  }

  #sign(body: string, sentAt: Date, key: string): Record<string, string> {
    const ts = String(Math.floor(sentAt.getTime() / 1000));
    const sig = createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
    return { [SIGNATURE_HEADER]: sig, [TIMESTAMP_HEADER]: ts };
  }

  parseWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
    now: Date,
  ): PaymentEvent | null {
    const sig = headers[SIGNATURE_HEADER];
    const ts = headers[TIMESTAMP_HEADER];
    if (!sig || !ts || !/^\d{1,12}$/.test(ts)) throw new WebhookRejected('signature');
    const expected = createHmac('sha256', this.#key).update(`${ts}.${rawBody}`).digest();
    const given = Buffer.from(sig, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookRejected('signature');
    }
    if (Math.abs(now.getTime() - Number(ts) * 1000) > PAYMENT_WEBHOOK_TOLERANCE_MS) {
      throw new WebhookRejected('timestamp');
    }
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new WebhookRejected('malformed');
    }
    if (p.type !== 'paid' && p.type !== 'expired' && p.type !== 'failed') return null;
    const occurredAt = new Date(String(p.occurred_at));
    if (
      typeof p.id !== 'string' ||
      typeof p.reference !== 'string' ||
      typeof p.checkout_id !== 'string' ||
      typeof p.amount !== 'number' ||
      !isRupiah(p.amount) ||
      Number.isNaN(occurredAt.getTime())
    ) {
      throw new WebhookRejected('malformed');
    }
    return {
      eventId: p.id,
      outcome: p.type,
      reference: p.reference,
      providerCheckoutId: p.checkout_id,
      amount: p.amount,
      occurredAt,
    };
  }
}
