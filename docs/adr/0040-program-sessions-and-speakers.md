# ADR-0040: Program: agenda sessions and speakers (section schema v2)

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0020 (typed, versioned sections), ADR-0021 (public sites)

## Decision

The agenda and speakers sections get a richer **version 2**. Following ADR-0020, a section never
changes shape in place: v1 stays valid and keeps rendering, because published revisions are
immutable.

| Section  | v1                   | v2                                                                                                                                 |
| -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Agenda   | time, title (max 50) | per session: ID, **day** (optional, for multi-day events), **start/end**, title, **room**, **description**, **speakers** (max 100) |
| Speakers | name, role (max 60)  | per speaker: ID, name, role, **bio** (max 60)                                                                                      |

**Validation (API).**

- Times are 24-hour, days are real `YYYY-MM-DD` dates, and an end must come after its start.
  The day and end may be left empty.
- Item IDs are unique within their section. **Speaker IDs are unique across the page**:
  sessions refer to them, and each bio is a link target.
- Every speaker a session names must exist in a v2 speakers section on the same page. v1
  speakers have no IDs and cannot be linked.
- All fields are plain text with length limits. There is no HTML, and renderers emit text nodes
  only.

**Times.** These are wall-clock times in the event's time zone. They are shown as entered, with a
"Times are in <zone>." note, and are never converted.

**No photos yet.** Speaker cards keep their initials. Photos from external URLs would require
allowing third-party images in the site's Content Security Policy, which allows tracking. They
wait for the asset library, which will serve images from our own storage.

**Rendering (shared by the editor preview and the public site).**

- Sessions are grouped by day (an undated group first), and sorted by start time within a day,
  keeping the organizer's order for ties.
- Each session shows its time range, title, room, "With <names>" and its description. Names
  link to the bio (`#speaker-<id>`) when the speakers section is shown, and are plain text when
  it is hidden.
- Speaker cards show name, role and bio.

**Editor.**

- New agenda and speakers sections are v2.
- A draft holding v1 sections opens **upgraded** to v2, with stable item IDs (`session-N`,
  `speaker-N`). This is an unsaved change, with a notice, until the organizer saves. People who
  cannot edit see the page as stored.
- **Sessions:** day, start, end, title, room, speaker checkboxes, description.
- **Speakers:** name, role, bio.
- Removing a speaker also removes them from every session, in one undo step, so the page never
  fails validation for a dangling link.

## Alternatives

- **Change v1 in place.** That breaks the immutability of published revisions, which would
  stop validating or rendering.
- **Speakers as free text on each session.** Simpler, but names drift between the agenda and
  the speakers list, and nothing can link them.
- **Photos by URL.** See above: they wait for the asset library. (Photos from the library were
  added as speakers v3 in ADR-0042.)

## Consequences

- No migration: section JSON is validated on save, and stored v1 content stays as it is until an
  organizer saves the upgraded draft.
- The public site's agenda handles multi-day events.
