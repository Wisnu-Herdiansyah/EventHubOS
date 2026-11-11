# ADR-0041: Registration questions

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0023 (registration), ADR-0027 (attendee export), ADR-0028 (check-in)
- Threat model: T67

## Decision

Organizers can ask up to **10 extra questions** on an event's sign-up form, after name and
email.

**Questions** are stored in the event settings, under `registration.questions`.

| Field      | Rule                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `id`       | Stable key of the answers (`question-N`); kept when the question is reworded              |
| `type`     | `short_text` (≤ 200), `long_text` (≤ 2,000), `choice` (2–20 distinct options) or `yes_no` |
| `label`    | One line, 1–200 characters                                                                |
| `help`     | Optional, one line, ≤ 200                                                                 |
| `required` | Whether an answer is needed                                                               |

IDs are unique, and only choice questions have options. Everything is plain text.

**Answers** are stored in `registration.answers` (jsonb, an object, at most 32 KB), keyed by
question ID.

- The public sign-up reads the event's **current** questions and checks the answers against
  them before anything is stored:
  - required answers are present;
  - text is within length and plain (a short answer is one line);
  - a choice is one of the options, exactly;
  - a yes/no is a boolean;
  - **unknown keys are refused**.
- Empty optional answers are dropped. Errors name the field (`body.answers.<id>`), so the form
  shows them under the question.
- A repeat sign-up never overwrites earlier answers.
- `public_register_with_answers` stores them. The earlier `public_register` stays (expand-only)
  and stores none.

**Answers are personal data**, like name and email.

- **Who sees them:** in the attendee list and the export (`registration.manage`,
  `registration.export_pii`; the export is audited).
- **Never at the door:** check-in search and ticket lookup return registrations **without**
  answers (data minimization).
- **Never anywhere else:** not in audit metadata, outbox payloads, emails or logs.
- **Isolation:** forced RLS on `registration`, as before.

**Changing questions.** Rewording keeps the answers, since they are keyed by ID. Removing a
question hides its answers from the list and the CSV, but keeps them stored, until data
retention (D9) is decided.

**Admin.**

- **Editor:** a Registration questions card in the event's settings. Questions are added,
  reworded, typed, made required, given options (one per line) or removed, then saved as a
  whole. Errors name the question ("Question 3 · Options: Give at least two options.").
- **No data loss between forms:** each form keeps what the other edits. The settings form
  replaces the whole `registration` section, so both actions read the current settings and
  merge on the server.
- **Registrations page:** an "Answers" disclosure per attendee.
- **CSV export:** one column per current question, with the same formula-injection protection
  as names (ADR-0027).

**Public site.** Questions render after email:

- short answer as an input, paragraph as a text area;
- choices and yes/no as radio groups (yes/no is a choice, so "required" can be enforced);
- help text and errors tied to their inputs;
- a failed submit keeps what was typed.

## Alternatives

- **A separate answers table** (one row per answer). Easier per-question reporting, but more
  joins and per-row RLS for little gain at 10 questions. Reporting on answers can be added
  later from the jsonb.
- **More types** (dates, multiple choice, file upload). Kept out: file upload needs the asset
  library, and each type adds validation and display work.
- **Checkbox for yes/no.** It cannot tell "no" from "not answered", so a required yes/no would
  be impossible.

## Consequences

- Organizers collect what they need without a second form. Every answer is more personal data
  to protect, which is why answers stay out of check-in, emails and logs.
- Data retention for answers follows registrations once D9 is decided.
