const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The registration ID from whatever a scanner produced (ADR-0029): the bare ID that ticket QR
 * codes hold, or a ticket link (…/ticket#id=…) pasted or read by a phone. Anything else is not a
 * ticket and is treated as a name search.
 */
export function ticketIdFromScan(text: string): string | null {
  const t = text.trim();
  const bare = /^[0-9a-f-]{36}$/i.test(t) && UUID.test(t) ? t : null;
  const linked = /(?:^#|[#&])id=([0-9a-f-]{36})(?:&|$)/i.exec(t)?.[1] ?? null;
  const id = bare ?? (linked && UUID.test(linked) ? linked : null);
  return id ? id.toLowerCase() : null;
}
