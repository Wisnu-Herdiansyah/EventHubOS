# ADR-0029: QR tickets and scanning at the door

- Status: accepted
- Date: 2026-11-10
- Builds on: ADR-0028 (check-in), ADR-0023 (registration emails)
- Threat model: T54–T56

## Decision

**What the QR code holds: the registration ID** (the product owner's choice). The alternatives
were a random ticket code stored as a hash, and an HMAC-signed code. The ID is a random UUID (v4),
so it cannot be guessed. It also appears in admin URLs, API responses and CSV exports, so anyone
who has seen one could produce a valid-looking ticket. Mitigations:

- Staff must be signed in with `attendee.checkin` to resolve any ticket.
- A ticket checks someone in once; a second scan says "already checked in at 09:12".
- Cancelled registrations are recognised, and tickets for other events are refused.
- If forged tickets become a real problem, a random ticket code can replace the ID without
  changing how scanning works: only what the QR holds and how it is resolved would change.

**Ticket delivery.** Emails are text-only (the email port has no HTML or attachments). The
confirmation email therefore links to `https://{handle}.{site}/{event-slug}/ticket#id={registration
ID}`.

- The ID is in the fragment, which browsers never send to servers. It does not reach site logs,
  and the site looks nothing up about the attendee.
- The page shows the event and draws the QR code in the browser (`qrcode`, the library the admin
  already uses for two-step setup). The code is black on white in both themes, with a quiet zone,
  and the page shows a short code for reading out.
- The page is marked noindex.

**API.** `GET …/check-in?ticket={id}` returns the one registration with that ID in this event and
organization, in any status, with the counts. A ticket for another event, or another
organization, returns nothing. `q` and `ticket` together are refused.

**Scanning at the door.** Two ways, both feeding the same flow: look up, then check in straight
away.

- **Handheld scanner.** Hardware scanners type into the focused search box and press Enter. The
  desk recognises a bare ID or a pasted ticket link and treats anything else as a name search.
- **Camera.** "Scan ticket" opens the device camera.
  - It decodes with the browser's `BarcodeDetector` where available. Elsewhere, for example iPhone
    Safari and desktop Linux, it uses the bundled `jsqr` (Apache-2.0, no dependencies), which is
    loaded only when needed.
  - Frames never leave the device, and the camera is released as soon as a code is read.
  - If camera access is blocked or there is no camera, the scanner says so and the desk keeps
    working.
  - The admin's `Permissions-Policy` now allows the camera for its own origin (`camera=(self)`);
    other origins are still refused. The public site still refuses the camera.

**Outcomes** are shown large, for the person at the door:

| Result                 | Shown as                                     |
| ---------------------- | -------------------------------------------- |
| Checked in             | "Ade Wisnu checked in." (status)             |
| Scanned twice          | "…was already checked in at 09:12." (alert)  |
| Cancelled              | "…'s registration was cancelled." (alert)    |
| Wrong event or unknown | "This ticket is not for this event." (alert) |

## Consequences

- Check-in at busy doors is one scan per person.
- The registration ID is now also a ticket credential; see the trade-off above.
