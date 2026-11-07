# ADR-0020: Event microsite pages, drafts and published revisions

- Status: accepted
- Date: 2026-11-07
- Implements: the microsite builder (PRD Phase 2), using the editor pattern from ADR-0019

## Decision

Each event has one microsite page (`page_key = 'home'`; the schema allows more pages later) made
of typed sections. People edit a **draft** and **publish** it as an **immutable revision**.

- **Data** (migration 0011, expand-only):
  - `event_page` holds the draft (`draft_sections` JSON, `draft_version` for optimistic
    concurrency, who and when) and points at the latest revision.
  - `page_revision` holds the published snapshots. The runtime role may insert and read them but
    has no UPDATE or DELETE privilege, so a published revision can never change.
  - Both tables are tenant-owned with forced RLS and composite foreign keys to their event.
- **Sections** (`apps/api/src/modules/page/sections.ts`): hero, text, agenda, speakers and
  registration, each with `version: 1` and a strict schema:
  - unknown types or fields are rejected;
  - every field is plain text with a length limit and no control characters;
  - at most 30 sections, each with a unique ID.

  Markup is stored as typed and rendered as text. A future shape change gets a new section
  version and a data migration, never a silent change.

- **API**:
  - `GET …/events/:eventId/page`: before the first save it returns a starter outline at
    version 0, and stores nothing.
  - `POST …/page/draft` (`page.edit`): saves the whole section list against `expectedVersion`.
  - `POST …/page/publish` (`event.publish`): publishes the version the person reviewed.
  - `GET …/page/revisions`: lists published revisions.

  Content editors can therefore edit but not publish. Archived events are read-only. Saves and
  publications are audited (`event.page_draft_saved`, `event.page_published`) with versions and
  counts only, never content, and emitted to the outbox; both mutations take idempotency keys.

- **Admin**: `/orgs/:orgId/events/:eventId/page` runs the three-panel editor on real data:
  - add, reorder, hide, duplicate and delete sections;
  - edit fields, including agenda and speaker items;
  - undo and redo, one step per field edit;
  - phone, tablet and desktop preview;
  - save, then publish with a confirmation;
  - list revisions.

  Leaving with unsaved edits asks first. API field errors are explained per section.

- **Not public yet.** There is no public route; public rendering (Phase 3) will read published
  revisions only, never drafts. The event lifecycle's `published` state stays unavailable until
  then.

## Consequences

- Page content is versioned and auditable from day one; rollback to an earlier revision can be
  added as "copy revision N into the draft".
- Whole-draft saves are simple and race-safe through the version check, at the cost of
  last-writer-loses-nothing conflicts that ask the second editor to reload. Real-time
  co-editing is out of scope.
- Images, brand colours and custom domains are later slices; their inputs will need the same
  validation discipline (threat model T33).
