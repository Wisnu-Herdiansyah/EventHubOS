# Platform staff runbook (ADR-0045)

Who may run this: operators with the migrator database credentials.

## Add a staff member

1. The person signs up for an EventHub account (or uses their existing one) with their work
   email.
2. Run, with `EVENTHUB_ENV` and `DATABASE_MIGRATOR_URL` set:

   ```bash
   pnpm platform:staff grant person@example.com --by "Your Name"
   ```

   It prints `granted`, or `unchanged` if they already are staff.

3. They turn on two-step verification in their account. Until then the Platform page shows only
   that instruction, and support access does not work for them.

## Remove a staff member

```bash
pnpm platform:staff revoke person@example.com --by "Your Name"
```

This takes effect on their next request, including any organization they were viewing under
support access.

## Check who changed staff

Platform-level audit entries `platform.staff_granted` and `platform.staff_revoked` (no
organization), with the operator's name in `metadata.operator`.

## Helping an organization

1. Ask an Owner or Admin to turn on **Settings → Support access** for the time you need (at most
   3 days).
2. Open **Platform**: the organization's name becomes a link while access lasts.
3. Everything you open is in the organization's audit log. You cannot change anything or see
   attendee details. If the work needs either, the organization does it themselves.
4. Ask them to turn access off when you are done; otherwise it ends on its own.

## Email not arriving for someone

**Platform → Email delivery**: look up the address.

- **Bounce:** lift it once the person confirms their mailbox works. The next email that is
  delivered also lifts it on its own.
- **Complaint:** the person marked an EventHub email as spam. Staff do not lift complaints.
  Emails the person asks for themselves (password reset, sign-up confirmation) still go.
