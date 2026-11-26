# ADR-0077: Rich text as structured blocks, never stored HTML

- Status: accepted
- Date: 2026-11-26
- Closes: D13 (rich-text format and sanitizer)

## Context

Event pages and announcements are plain text today. Organizers want headings, emphasis, lists
and links. The architecture rule is that section instances are typed and versioned with
validated schemas, and **no tenant HTML is ever executed** (ADR-0020). Decided with the product
owner on 2026-11-26.

## Decision

Rich text is stored as **structured blocks**: typed JSON validated by a versioned schema and
drawn by EventHub's own renderer. **No HTML is ever stored or accepted**, so there is nothing to
sanitize.

- **Blocks:** paragraph, heading (levels 2 and 3), bulleted list, numbered list, quote.
- **Inline:** text with **bold** and _italic_ marks, and links.
- **Links:** `https:` and `mailto:` only. They open with `rel="noopener noreferrer"`, and the
  address shown is the address used.
- **Limits:** depth, block count and text length, enforced by the schema.
- **Rendering:** the site and the email renderer map each block to fixed markup. Emails get a
  plain-text version too.
- **Plain text keeps working:** existing plain-text fields stay valid; a field moves to blocks
  in a new schema version, as sections already do (ADR-0020).

Set aside: a **Markdown subset** (output still has to be sanitized, and edge cases differ
between parsers) and **sanitized HTML** (the largest attack surface).

## To build (later slices)

The schema and renderer in `packages/microsite`, a small editor in the admin, then rich text in
the text section and in announcements.
