# ADR-0075: Record which Terms and Privacy Policy versions were accepted

- Status: accepted (documents to be supplied by the product owner)
- Date: 2026-11-26
- Closes: D10 (legal acceptance artefacts for ORG-01)

## Context

Creating an organization (ORG-01) should capture agreement to EventHub's Terms of Service and
Privacy Policy. Today only a verified email is required. GR 33/2026 restricts consent that is
bundled with acceptance of general terms
([Chambers](https://chambers.com/practice-guides/guides/data-protection-privacy-2026/indonesia/law-and-practice)),
so accepting terms and consenting to processing are kept apart. Decided with the product owner
on 2026-11-26.

## Decision

- When someone creates an organization, they **tick to accept the current Terms of Service
  and Privacy Policy**. The tick is not pre-ticked.
- EventHub records **which version** of each document, **who** accepted it, **when**, and
  **for which organization**. Records are append-only.
- **A new version asks again.** The next time an Owner signs in after a version change, they
  accept the new version before continuing.
- **The product owner supplies the documents.** EventHub stores each version's identifier,
  publication date and address, and makes no claim about the content. Until real documents
  exist, sign-up stays closed to the public (D10 "before external sign-up").
- Attendees registering for an event accept the **organizer's** privacy notice, already
  required per event (`legal.privacyPolicyUrl`). This ADR is about organizers' acceptance of
  EventHub's own terms.

## To build (later slice)

A migration for document versions and acceptances, the checkbox at organization creation, the
re-acceptance step at sign-in, and tests (including cross-tenant ones).
