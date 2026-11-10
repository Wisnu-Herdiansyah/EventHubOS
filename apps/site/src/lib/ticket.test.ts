import { describe, expect, it } from 'vitest';
import { internalPath } from './host';
import { shortTicketCode, ticketIdFromHash, ticketQrPath } from './ticket';

const ID = '3f2a91c0-5b7e-4c2d-9a1f-0e8d7c6b5a49';

describe('tickets (ADR-0029)', () => {
  it('reads the registration ID from the fragment only', () => {
    expect(ticketIdFromHash(`#id=${ID}`)).toBe(ID);
    expect(ticketIdFromHash(`#x=1&id=${ID.toUpperCase()}`)).toBe(ID);
    expect(ticketIdFromHash('#id=not-a-uuid')).toBeNull();
    expect(ticketIdFromHash(`#id=${ID}x`)).toBeNull();
    expect(ticketIdFromHash('')).toBeNull();
  });

  it('shows a short code for reading out', () => {
    expect(shortTicketCode(ID)).toBe('3F2A-91C0');
  });

  it('draws a QR code with a quiet zone', () => {
    const { size, d } = ticketQrPath(ID);
    // A 36-character ID at level M fits version 3 (29 modules) + 2×4 quiet zone.
    expect(size).toBe(37);
    expect(d.startsWith('M4 4h1v1h-1z')).toBe(true); // finder pattern corner
    expect(d).not.toMatch(/M[0-3] /); // nothing inside the quiet zone
  });

  it('routes /{slug}/ticket to the ticket page, and nothing deeper', () => {
    expect(internalPath('awh', '/jakarta-summit/ticket')).toBe('/s/awh/jakarta-summit/ticket');
    expect(internalPath('awh', '/jakarta-summit/ticket/x')).toBeNull();
    expect(internalPath('awh', '/jakarta-summit/other')).toBeNull();
  });
});
