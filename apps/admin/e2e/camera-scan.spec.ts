import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import QRCode from 'qrcode';
import { createEventViaApi, createOrgViaApi, signIn, test, verifiedAccount } from './support';

/**
 * The camera path of ticket scanning (ADR-0029), end to end: Chromium's fake camera plays a
 * video of a ticket QR code and the desk decodes it. The ticket names no registration of this
 * event, so the desk must say so; that proves the frame was read and looked up.
 */
const TICKET = '7d1c9f2e-4b3a-4e5f-8a6b-1c2d3e4f5a6b';
const W = 640;
const H = 480;

function qrVideo(): string {
  const qr = QRCode.create(TICKET, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const scale = Math.floor(320 / (n + 8));
  const left = Math.floor((W - (n + 8) * scale) / 2);
  const top = Math.floor((H - (n + 8) * scale) / 2);
  const y = Buffer.alloc(W * H, 255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = top + (r + 4) * scale + dy;
        y.fill(0, row * W + left + (c + 4) * scale, row * W + left + (c + 5) * scale);
      }
    }
  }
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma]);
  const file = join(tmpdir(), `eventhub-ticket-${process.pid}.y4m`);
  writeFileSync(
    file,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]),
  );
  return file;
}

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${qrVideo()}`,
    ],
  },
  permissions: ['camera'],
});

test('the camera reads a ticket QR code and the desk looks it up', async ({ page }) => {
  const owner = await verifiedAccount('camera');
  const orgId = await createOrgViaApi(owner.token, 'Camera Org');
  const eventId = await createEventViaApi(owner.token, orgId);
  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}/events/${eventId}/check-in`);

  await page.getByRole('button', { name: 'Scan ticket' }).click();
  await expect(page.getByRole('group', { name: 'Ticket scanner' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'This ticket is not for this event.',
    { timeout: 15_000 },
  );
  // The camera is released once a code is read.
  await expect(page.getByRole('group', { name: 'Ticket scanner' })).toHaveCount(0);
});
