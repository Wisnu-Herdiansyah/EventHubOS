# ADR-0045: Platform staff and support access

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0003 (tenant isolation), ADR-0013 (audit log), ADR-0022 (two-step
  verification), ADR-0043 (email suppression)
- Threat model: T74, T75, T76
- Runbook: `docs/operations/platform-staff-runbook.md`

## Decision

EventHub needs people who can help organizations. They must not be a way around tenant
isolation. This slice adds **platform staff**, **support access** that each organization
controls, and a few staff tools.

### Becoming staff: operator command only

- `pnpm platform:staff grant|revoke <email> --by "<operator name>"` runs with migrator
  credentials (`DATABASE_MIGRATOR_URL`).
- No API route or web page can make anyone staff. A compromised account, even an Owner or a
  staff member, cannot promote itself or others.
- Each change is audited at platform level (`platform.staff_granted` / `platform.staff_revoked`,
  with the operator's name).
- `platform_staff` has no grants for the runtime roles. Database functions read it.
- Revoking takes effect on the next request, including any support access in progress.

### What staff can do

Every staff tool needs **two-step verification**. The API checks it, and the database functions
check staff status and two-step verification again.

| Tool                                           | What it shows or does                                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/platform/me`                          | Whether the caller is staff (for the Platform link)                                                                                                                                                                          |
| `GET /v1/platform/organizations`               | The newest 500 organizations: name, public address, status, member and event counts, support status. No member, attendee or billing details                                                                                  |
| `GET /v1/platform/email-suppressions?address=` | Why one address gets no email                                                                                                                                                                                                |
| `POST …/lift-bounce`                           | Lift a **bounce** by hand, e.g. after the person fixed their mailbox. **Complaints are never lifted by staff**: the person asked not to be emailed. Audited at platform level with a SHA-256 of the address, not the address |

### Support access: the organization decides

- **Granting.** An Owner or Admin (`organization.manage`) turns it on in Settings for 1, 8, 24
  or 72 hours. The database caps a grant at 72 hours.
- **One at a time.** There is one active grant; a second answers `409 support_access_active`.
- **Revoking.** An Owner or Admin can turn it off at any time.
- **Notice.** Granting and revoking are audited, and every Owner is emailed with who did it and
  until when.
- **The `support` role.** While a grant is active, staff with two-step verification who are not
  members get the read-only `support` role, through the same tenant guard as everyone else
  (`withOrganization`):
  - **Can:** `organization.read`, `membership.read`, `event.read`, `report.read`, `audit.read`.
  - **Cannot:** anything that changes data, and no attendee data (`registration.manage` and
    `registration.export_pii` are not included).
  - It is not a membership role: it cannot be invited, assigned or granted (`isRole` is false;
    catalog version 2).
- **Staff cannot extend their own access.** Granting and revoking need `organization.manage`,
  which `support` never has.
- **Every access is audited** in the organization's own log: `support.accessed`, actor
  `platform_support`, with the permission used. Refused attempts change nothing and leave no
  entry.
- **Access ends** (404 again, as for any non-member) when the grant is revoked or expires, when
  the staff member is removed or turns off two-step verification, or when the organization is
  suspended.
- **Visible to staff.** While viewing, they see a banner on every page: read-only, no attendee
  details, until when, and recorded.

## Alternatives

- **Staff self-serve with a reason ("break glass").** Faster for support, but the organization
  loses control and learns only afterwards. It may be added later for emergencies, behind a
  second approver.
- **Staff can add staff in the web app.** Convenient, but one compromised staff account could
  create more. The operator command keeps that power with the people who already hold database
  credentials.
- **A support login that impersonates a member.** It confuses who did what and would inherit
  that member's write access. A separate read-only role keeps the audit trail honest.
- **Read access to attendee data during support.** Often unnecessary for "the page looks wrong"
  kinds of help, and personal data. It can become a separate, explicitly granted level later.

## Consequences

- Each page a staff member opens writes an audit row: more rows, but exactly the evidence an
  organization wants.
- Staff need accounts on the same identity system as customers, with two-step verification. SSO
  for staff waits for D3.
- Suspending organizations, and support that changes data, are follow-ups. Both would need
  their own approval and audit design.
