import QRCode from 'qrcode';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The registration ID from a ticket link's fragment (#id=…), or null (ADR-0029). */
export function ticketIdFromHash(hash: string): string | null {
  const m = /(?:^#|&)id=([0-9a-fA-F-]{36})(?:&|$)/.exec(hash);
  const id = m?.[1]?.toLowerCase();
  return id && UUID.test(id) ? id : null;
}

/** "3F2A-91C0": the first 8 hex digits, for reading out when a scanner fails. */
export function shortTicketCode(id: string): string {
  return id
    .replace(/-/g, '')
    .slice(0, 8)
    .toUpperCase()
    .replace(/^(.{4})/, '$1-');
}

/**
 * The QR code for a ticket as one SVG path (one 1×1 square per dark module), with the 4-module
 * quiet zone scanners need. Drawn as React elements, so no HTML strings reach the page.
 */
export function ticketQrPath(id: string): { size: number; d: string } {
  const qr = QRCode.create(id, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return { size: n + quiet * 2, d };
}
