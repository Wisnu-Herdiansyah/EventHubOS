# ADR-0070: Paid ticketing: organizers sell, Xendit xenPlatform, Indonesia in rupiah

- Status: accepted (provider terms to confirm before launch)
- Date: 2026-11-26
- Closes: D2 (payment provider, merchant-of-record model, launch market)

## Context

Every event is free today. Paid tickets need four answers: who sells the ticket, where and in
which currency, which provider, and how the platform earns from it. The decision was made with
the product owner on 2026-11-26.

## Decision

### Organizers sell their own tickets

Each organizer is the seller (merchant of record) of their tickets. EventHub is a platform: it
opens checkouts on the organizer's own provider account and takes a **platform fee** from each
payment. EventHub does not collect ticket money and pay it out, and is not the seller of record.
What that means for tax on ticket sales is for each organizer and their advisers; EventHub makes
no legal or tax claim here.

### Launch market: Indonesia, rupiah only

- Amounts are **whole rupiah** (`Rupiah`, an integer). There are no fractional amounts.
- One checkout charges at most Rp 1,000,000,000, a guard against unit mistakes.
- Other countries and currencies are not supported until a later decision.

### Provider: Xendit xenPlatform

Chosen because it is built for platforms: each organizer gets a sub-account, a payment can be
split, and a flat or percentage **platform fee** is moved to the platform account when the
payment settles ([xenPlatform](https://docs.xendit.co/xenplatform),
[split payments](https://docs.xendit.co/docs/split-payments)).

Options set aside:

| Option         | Why not now                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Midtrans       | No documented split at checkout: EventHub would collect and then pay out (Iris/Payouts), acting as the seller, which this ADR rules out.                                                   |
| Stripe Connect | Invite-only in Indonesia, IDR only, no cross-border; sources disagree on Connect support there ([Stripe](https://support.stripe.com/questions/stripe-indonesia-support-for-marketplaces)). |

**To confirm with Xendit before launch** (not assumed here):

- Current prices, and who is billed the xenPlatform fees (sub-account activity and in-house
  transaction fees). Xendit's own pages disagree on whether Indonesian fees are billed to the
  platform or deducted from the sub-account
  ([FAQ](https://help.xendit.co/hc/en-us/articles/4413990486041-How-Much-is-XenPlatform-Fee),
  [fees](https://docs.xendit.co/docs/xenplatform-fees)).
- The sub-account type (owned or managed) and what onboarding each organizer goes through.
- Refunds and chargebacks, and the webhook signing scheme.

### The port

`PaymentGateway` in `packages/kernel/src/payments.ts`, provider-neutral:

- `createSellerAccount`: one per organization.
- `createCheckout`: **idempotent per order reference**. The same reference returns the same
  checkout, and a changed amount, fee or seller under a used reference is refused.
- `parseWebhook`: verifies the signature, refuses deliveries older than 5 minutes, and maps
  `paid`, `expired` and `failed`; other event types return null. The caller checks the paid
  amount against its order.
- `assertCheckoutRequest`: one set of checks for every adapter, before any provider call. A
  whole-rupiah amount above zero; a fee of at least 0 and **below** the amount; HTTPS return
  addresses; an order reference of 8–64 lowercase characters.

`InMemoryPaymentGateway` is the local and test fake: it signs its own webhooks with a test key.
The shared contract `testing/payment-gateway.contract.ts` runs against it now.

**The Xendit adapter is not written.** Per the project rules it stops at the provider boundary:
it is built against Xendit's test mode, with real credentials and documentation, and must pass
the same contract before any route uses it. No credential, endpoint or payment behaviour is
assumed in this repository.

## Not yet decided (next steps)

- Ticket types, prices and order records (a migration), refund and cancellation rules, and the
  platform fee amount.
- EventHub's own subscription billing for organizers (BIL-\*), which this ADR does not cover.

## Tests

The contract (7) runs against the fake. Unit tests (6) cover one account per organization, the
field named in a refusal, a zero amount reported as the amount, unknown event types ignored,
and malformed bodies. 11 mutation checks on the payment rules are all caught.
