'use client';

import { useEffect, useState } from 'react';
import { shortTicketCode, ticketIdFromHash, ticketQrPath } from '@/lib/ticket';

/** Draws the QR code from the fragment. Shown at the door; nothing is sent anywhere. */
export function Ticket() {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = () => setId(ticketIdFromHash(window.location.hash));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  if (id === undefined) return <p role="status">Loading your ticket…</p>;
  if (!id) {
    return (
      <p className="site-error" role="alert">
        This ticket link is incomplete. Open it from your confirmation email again.
      </p>
    );
  }
  const { size, d } = ticketQrPath(id);
  const code = shortTicketCode(id);
  return (
    <figure className="site-ticket__qr">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Ticket QR code ${code}`}
        shapeRendering="crispEdges"
      >
        <rect width={size} height={size} fill="#fff" />
        <path d={d} fill="#000" />
      </svg>
      <figcaption>
        Show this at the door. Ticket <span className="site-ticket__code">{code}</span>
      </figcaption>
    </figure>
  );
}
