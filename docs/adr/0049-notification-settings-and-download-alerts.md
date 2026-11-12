# ADR-0049: Email notification settings and data download alerts

- Status: accepted
- Date: 2026-11-12
- Builds on: ADR-0026 (security change emails), ADR-0027 (attendee export), ADR-0045 (support
  access), ADR-0047 (audit log export)
- Threat model: T49, T50, T77 (updated), T79 (new)

## Context

Until now the only emails sent to organization members were security notices:

- changes to the two-step requirement (to Owners);
- support access turned on or off (to Owners);
- two-step reminders.

None of them should be optional. The open residual on T49 ("notification preferences") and the
detective controls on bulk exports (T50, T77) both need a notice people can choose to receive.

## Decision

### Data download alerts

- When someone downloads the **attendee list** of an event or the **audit log**, the export writes
  an `organization.data_downloaded` outbox event. It is written in the same transaction as the
  export's audit entry.
- The payload holds the kind of download, the row count, whether the file was truncated, and,
  for an attendee list, the event's ID and name. It never holds attendee details.
- The worker emails each **active, verified Owner and Admin**, except the person who downloaded.
  The email says who downloaded what, when, and how many rows. It links to the audit log and to
  the setting.
- Each recipient's message ID is `{event ID}-{user ID}`, so a retried delivery is the same
  message.
- Exports stay exempt from idempotency keys:
  - an attendee list must not be stored for replay (ADR-0027);
  - a retried export is a second, real download, and it is alerted and audited as one.

### Settings

- `notification_preference` (migration `0031`) stores one row per organization, member and kind.
  Having no row means the kind's default.
- Forced RLS limits every read and write to **the caller's own row in the organization of the
  request**. An Owner cannot see or change an Admin's choice, even with SQL. The worker has no
  table access. It calls `organization_notice_recipients`, which applies:
  - the roles;
  - active membership;
  - verified email;
  - the person's choice;
  - leaving out the person who downloaded.
- `NOTIFICATIONS` in `packages/kernel` is the catalog. Today it has `data_download`, for Owners and
  Admins, on by default. A unit test keeps it in step with the kinds, roles and default in the
  migration.
- `GET` and `PATCH /v1/organizations/{id}/notification-settings[/{kind}]`:
  - any member may read their own settings;
  - a change needs an idempotency key, applies only to kinds offered to the caller's role, and is
    audited (`notification.setting_changed`) only when the value actually changes;
  - support access gets 403 `members_only`.
- Security notices are listed as "always sent" for the roles that get them. They cannot be turned
  off: they exist so a misused account cannot weaken the organization quietly.
- The admin Settings page has an **Email notifications** card. It holds the person's own checkbox
  and the list of notices always sent to them.

## Alternatives

- **Account-wide settings, not per organization.** People who belong to several organizations
  often want alerts from one and not another. Per-organization settings also keep the data under
  the tenant's RLS.
- **Letting Owners set alerts for everyone.** That would let one Owner silence another's view of
  exports, which is the misuse the alert exists to catch.
- **Making the download alert mandatory.** It would be noisy for organizations that export daily,
  and people would learn to ignore it. The audit entry is mandatory; the email is a choice, on by
  default.
- **Alerting the person who downloaded.** They already know. A copy to them would only train
  people to ignore the email.
- **Digests instead of one email per download.** They need a scheduler and per-person batching.
  Downloads are rare enough that one email each is clearer. A digest can come later as another
  kind.

## Consequences

- Bulk copies of personal data and audit evidence are visible to the other Owners and Admins
  within the worker's delay, unless they opted out. They are always in the audit log.
- New optional notices are added as catalog entries plus a value in the table's `kind` check (an
  expand-only migration).
