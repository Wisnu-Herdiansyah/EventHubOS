import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmailMessage, EmailSender } from '@eventhub/kernel';

/**
 * Local-development email adapter: writes each message as a JSON file (mode 0600) so developers
 * can open verification links without an email provider. Refused by config outside local/ci.
 */
export class LocalFileEmailSender implements EmailSender {
  readonly name = 'local_file';
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async send(message: EmailMessage): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const safeId = message.messageId.replace(/[^A-Za-z0-9-]/g, '_');
    // Same messageId overwrites the same file: idempotent like a provider's dedupe key.
    await writeFile(join(this.#dir, `${safeId}.json`), `${JSON.stringify(message, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
