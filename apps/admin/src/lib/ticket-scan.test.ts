import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { ticketIdFromScan } from './ticket-scan';

const ID = '3f2a91c0-5b7e-4c2d-9a1f-0e8d7c6b5a49';

/** Renders a QR code the way the public ticket page does (level M, 4-module quiet zone). */
function render(text: string, scale = 6) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size + 8;
  const w = n * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let r = 0; r < qr.modules.size; r++) {
    for (let c = 0; c < qr.modules.size; c++) {
      if (!qr.modules.get(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + 4) * scale + y) * w + (c + 4) * scale + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return { px, w };
}

describe('ticket scanning (ADR-0029)', () => {
  it('accepts a bare ID or a ticket link, and nothing else', () => {
    expect(ticketIdFromScan(ID)).toBe(ID);
    expect(ticketIdFromScan(`  ${ID.toUpperCase()}\n`)).toBe(ID);
    expect(ticketIdFromScan(`https://awh.eventhub.example/summit/ticket#id=${ID}`)).toBe(ID);
    expect(ticketIdFromScan('Ade Wisnu')).toBeNull();
    expect(ticketIdFromScan(`${ID}x`)).toBeNull();
    expect(ticketIdFromScan(`https://evil.example/?id=${ID}`)).toBeNull();
    expect(ticketIdFromScan('')).toBeNull();
  });

  it('reads back a ticket QR code with the fallback decoder', () => {
    const { px, w } = render(ID);
    const found = jsQR(px, w, w);
    expect(found?.data).toBe(ID);
    expect(ticketIdFromScan(found!.data)).toBe(ID);
  });
});
