/**
 * WhatsApp messages (ADR-0072): confirmations and reminders sent as pre-approved templates to
 * people who opted in. The provider is Meta's WhatsApp Cloud API; its adapter maps this port to
 * Meta's API and passes the shared contract in `testing/whatsapp-sender.contract.ts` against a
 * test number before it is used. Domain code never sees provider formats; message text and
 * phone numbers never enter logs, audit records or error messages.
 */

/** A phone number in E.164 form: "+", country code, number; 8 to 15 digits in all. */
export const E164 = /^\+[1-9]\d{7,14}$/;

/** Our template names: lowercase letters, digits and underscores, as registered with Meta. */
export const TEMPLATE_NAME = /^[a-z][a-z0-9_]{0,99}$/;

/** Languages our templates are registered in. */
export const TEMPLATE_LANGUAGES = ['id', 'en'] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

/** The most a single template parameter may hold. */
export const TEMPLATE_PARAMETER_MAX = 200;

export class InvalidMessage extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`invalid message: ${field}: ${message}`);
    this.name = 'InvalidMessage';
    this.field = field;
  }
}

export interface WhatsAppTemplateMessage {
  /** Stable ID (e.g. derived from the domain event): sending it twice sends once. */
  messageId: string;
  /** The recipient in E.164 form; see normalizeIndonesianPhone. */
  to: string;
  template: string;
  language: TemplateLanguage;
  /** Values for the template's placeholders, in order: one line of plain text each. */
  parameters: string[];
}

export interface WhatsAppSender {
  readonly name: string;
  /** Returns the provider's message ID. Idempotent per `messageId`. */
  sendTemplate(message: WhatsAppTemplateMessage): Promise<{ providerMessageId: string }>;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Checks a message the same way for every adapter, before any provider call. */
export function assertWhatsAppMessage(m: WhatsAppTemplateMessage): void {
  if (!m.messageId.trim()) throw new InvalidMessage('messageId', 'required');
  if (!E164.test(m.to)) throw new InvalidMessage('to', 'a phone number in E.164 form');
  if (!TEMPLATE_NAME.test(m.template)) {
    throw new InvalidMessage('template', 'lowercase letters, digits and underscores');
  }
  if (!(TEMPLATE_LANGUAGES as readonly string[]).includes(m.language)) {
    throw new InvalidMessage('language', TEMPLATE_LANGUAGES.join(' or '));
  }
  m.parameters.forEach((p, i) => {
    if (!p.trim() || p.length > TEMPLATE_PARAMETER_MAX || CONTROL.test(p)) {
      throw new InvalidMessage(
        `parameters[${i}]`,
        `one line of plain text, 1 to ${TEMPLATE_PARAMETER_MAX} characters`,
      );
    }
  });
}

/**
 * An Indonesian mobile number as people type it ("0812-3456-7890", "+62 812 3456 7890",
 * "62812…", "812…") in E.164 form, or null when it is not one. Indonesian mobile numbers start
 * with 8 after the country code and have 9 to 12 digits after it. Other countries are not
 * accepted yet (the launch market is Indonesia, ADR-0070).
 */
export function normalizeIndonesianPhone(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('62')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  else if (trimmed.startsWith('+')) return null;
  return /^8\d{8,11}$/.test(digits) ? `+62${digits}` : null;
}

/** In-memory sender: a local/test fake only. Configuration must refuse it outside local and test. */
export class InMemoryWhatsAppSender implements WhatsAppSender {
  readonly name = 'in_memory';
  readonly sent: WhatsAppTemplateMessage[] = [];
  readonly #ids = new Map<string, string>();
  #failNext = 0;

  failNext(count: number): void {
    this.#failNext = count;
  }

  sendTemplate(message: WhatsAppTemplateMessage): Promise<{ providerMessageId: string }> {
    try {
      assertWhatsAppMessage(message);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.#failNext > 0) {
      this.#failNext -= 1;
      return Promise.reject(new Error('in-memory WhatsApp sender: simulated outage'));
    }
    const known = this.#ids.get(message.messageId);
    if (known) return Promise.resolve({ providerMessageId: known });
    const providerMessageId = `wamid.test-${this.sent.length + 1}`;
    this.#ids.set(message.messageId, providerMessageId);
    this.sent.push(structuredClone(message));
    return Promise.resolve({ providerMessageId });
  }
}
