# ADR-0011: Event settings, setup checklist, and lifecycle

- Status: accepted
- Date: 2026-11-06
- Implements: PRD EVT-02 (settings), EVT-03 (setup checklist), EVT-05 (archive/restore; purge
  deferred to the retention policy D9)

## Decision

**Settings.** Presentation and configuration live in `event.settings` (JSON, `settings_version`),
validated by a strict schema: `visibility` (public, unlisted, private), `registration`
(opensAt, closesAt, capacity), `sharing` (title ≤ 70, description ≤ 200), `contact` (email, E.164
phone, HTTPS URL), and `legal` (HTTPS privacy, terms, and code-of-conduct links). Unknown keys are
rejected. Cross-field checks bind the registration window to the event schedule. Ownership,
lifecycle, and schedule stay in relational columns. Theme/brand selection and the sharing image
wait for the Phase 2 design system and asset library.

**Updates.** `PATCH /v1/organizations/{org}/events/{id}` needs `event.update`, an
`Idempotency-Key`, and `expectedVersion` (optimistic concurrency: a stale version gets `409
version_conflict`). Each provided settings section replaces the stored one, and `null` clears it.
The slug can change only in draft (routing stability). Audit records changed field _names_, never
values (contact details are personal data).

**Checklist.** `GET …/checklist` is deterministic:

| Item                                                                  | Severity    |
| --------------------------------------------------------------------- | ----------- |
| `schedule.starts_in_future`                                           | blocking    |
| `sharing.metadata` (title and description; not required when private) | blocking    |
| `legal.privacy_policy`                                                | blocking    |
| `contact.details`                                                     | recommended |
| `registration.window`                                                 | recommended |
| `legal.terms`                                                         | recommended |

Scheduling requires every blocking item complete and **each incomplete recommended item listed
in `acknowledgedWarnings`**. The acknowledgement is recorded in the audit event. A scheduled
event may not be edited into a blocking-incomplete state (`checklist_regression`); unschedule it
first.

**Lifecycle.** `POST …/transitions {to, expectedVersion, acknowledgedWarnings}`. Only named
transitions exist, each gated by its own permission:

| From → To                                                              | Permission      | Status                                                                                                |
| ---------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| draft → scheduled                                                      | `event.publish` | available (checklist)                                                                                 |
| scheduled → draft                                                      | `event.publish` | available                                                                                             |
| scheduled → published, published → live/ended, live → ended            | `event.publish` | **unavailable** (`requires_published_revision`) until page publishing (Phase 2) and routing (Phase 3) |
| draft/scheduled/ended → archived                                       | `event.archive` | available                                                                                             |
| archived → draft (from draft/scheduled), archived → ended (from ended) | `event.archive` | available                                                                                             |

`archived_from` records the origin; a database CHECK keeps it consistent even for the schema
owner. Restoring a scheduled event returns it to _draft_ so the checklist runs again. Archived
events are read-only. Each transition sets `lifecycle_changed_at` and writes audit plus
`event.lifecycle_changed` outbox records.

## Consequences

- Publishing, going live, and ending become available when Phase 2 adds immutable published page
  revisions. The rules and permissions already exist.
- The checklist will grow (pages present, registration form configured, domain bound) as those
  features land. Items must stay deterministic.
- Archived events will also reject public writes (registrations) once those exist (Phase 3).
- Purge after archive waits for the retention policy (D9).
