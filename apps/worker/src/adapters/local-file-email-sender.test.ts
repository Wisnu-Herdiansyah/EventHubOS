import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailSenderContract } from '@eventhub/kernel/testing';
import { describe, expect, it } from 'vitest';
import { LocalFileEmailSender } from './local-file-email-sender.ts';

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'eventhub-mail-'));
  const sender = new LocalFileEmailSender(join(dir, 'inbox'));
  return {
    dir: join(dir, 'inbox'),
    sender,
    delivered: async () =>
      Promise.all(
        (await readdir(join(dir, 'inbox'))).map(async (f) =>
          JSON.parse(await readFile(join(dir, 'inbox', f), 'utf8')),
        ),
      ),
  };
}

emailSenderContract('local_file', harness);

describe('LocalFileEmailSender', () => {
  it('writes owner-only files and is idempotent per messageId', async () => {
    const h = await harness();
    const m = {
      messageId: '../../etc/passwd',
      to: 'a@example.test',
      template: 't',
      subject: 's',
      text: 'x',
    };
    await h.sender.send(m);
    await h.sender.send(m);
    const files = await readdir(h.dir);
    expect(files).toEqual(['______etc_passwd.json']); // path traversal neutralised, one file
    expect((await stat(join(h.dir, files[0]!))).mode & 0o777).toBe(0o600);
  });
});
