# ADR-0072: WhatsApp messages through Meta's Cloud API

- Status: accepted (rates and template approval to confirm before launch)
- Date: 2026-11-26
- Closes: D4 for WhatsApp. SMS stays open until needed.

## Context

Email is the only channel today. In Indonesia, the launch market (ADR-0070), people read
WhatsApp more than email, so ticket confirmations and reminders are more likely to be seen
there. Decided with the product owner on 2026-11-26: WhatsApp first, directly through Meta.

## Decision

### Channel and provider

- **WhatsApp first**, through **Meta's WhatsApp Cloud API directly**, not a reseller. There is
  no reseller markup, and template sending is built behind a port.
- Messages are **pre-approved templates**: confirmations, reminders and changes to an event the
  person registered for. Each person **opts in** to WhatsApp when they register. That opt-in
  is recorded with the registration when the feature is built; email stays the default.
- **SMS stays open** (D4) until there is a need WhatsApp does not cover.

### Cost (to confirm)

Meta charges per message by market and category
([Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)).
For Indonesia, resellers reported a utility message at about **Rp 356.65 plus 11% VAT**, from
mid- or late 2026 ([ChatMaxima](https://chatmaxima.com/whatsapp-api-pricing/indonesia/),
[SleekFlow](https://sleekflow.io/id-id/blog/simulasi-biaya-whatsapp-api-dalam-rupiah-tarif-ppn-dan-tagihan-bulanan)).
One reseller listed Rp 366.65 ([Qontak](https://help-center.qontak.com/hc/en-us/articles/48430892733465-Latest-WhatsApp-Message-Prices-October-2026)).
Two of them also report that, from 1 October 2026, utility templates are charged even inside
the 24-hour reply window. **These are not Meta's own figures**: confirm against Meta's rate card
before setting any budget or plan limit.

### The port

`WhatsAppSender` in `packages/kernel/src/messaging.ts`, provider-neutral:

- `sendTemplate`: sends a template to an E.164 number with its parameters in order, and is
  **idempotent per message ID**. The same message ID sends once and returns the same provider
  message ID.
- `assertWhatsAppMessage`: one set of checks before any provider call. An E.164 number; a
  template name of lowercase letters, digits and underscores; language `id` or `en`;
  parameters of 1–200 characters on one line.
- `normalizeIndonesianPhone`: the ways people type a mobile number ("0812-3456-7890",
  "+62 812 3456 7890", "62812…", "812…") become `+62812…`. Landlines, numbers of the wrong
  length and other countries are refused.

`InMemoryWhatsAppSender` is the local and test fake. The shared contract
`testing/whatsapp-sender.contract.ts` runs against it now.

**The Meta adapter is not written.** It is built against a test number with real credentials,
and must pass the same contract before anything sends. No credential, endpoint or template is
assumed here. Phone numbers and message text never enter logs, audit records or error messages.

## Not yet decided (next steps)

- The opt-in field and wording on the registration form (a migration), and which templates to
  register with Meta and in which languages.
- Delivery and read receipts by webhook, and opting out.

## Tests

The contract (4) runs against the fake. Unit tests cover the eight ways a number is typed, the
length limits, refused numbers, and a simulated outage. 5 mutation checks on the messaging rules
are all caught.
