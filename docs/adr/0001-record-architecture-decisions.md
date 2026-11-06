# ADR-0001: Record architecture decisions

- Status: accepted
- Date: 2026-11-06

## Context

EventHub OS is delivered in phases against a fixed target architecture
(`TECHNICAL_ARCHITECTURE.md`). Deviations, provider choices, and invariant changes must be
traceable so later phases are not blocked by undocumented shortcuts.

## Decision

- Significant decisions are recorded as numbered ADRs in `docs/adr/` using `0000-template.md`.
- An ADR is required for: new runtime dependencies of architectural weight, provider/vendor
  selection, any change to tenant isolation, idempotency/audit/outbox, publishing, or data
  retention, and any deviation from the proposed baseline.
- Unresolved decisions live in `docs/architecture/open-decisions.md` until an ADR closes them.
- ADRs are immutable once accepted; changes are made by a superseding ADR.

## Consequences

Reviewers can reject PRs that change invariants without an ADR.
