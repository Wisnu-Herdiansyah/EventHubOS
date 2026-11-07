# ADR-0019: Apple-inspired design system for EventHub OS

- Status: accepted
- Date: 2026-11-07
- Supersedes: the navy/beige visual style of ADR-0014 (behaviour and security unchanged)

## Context

The admin app grew screen by screen with one stylesheet. Styles were duplicated, there was no
dark mode or application navigation, and the next large features (the microsite builder and
public microsites) need shared components first. The product direction is an interface inspired
by Apple's design principles: clarity, deference, depth, consistency and simplicity.

## Decision

- **Tokens first.** `styles/tokens.css` is the only place with colours, type, spacing, shape,
  depth and motion. Colours are `light-dark()` pairs on the specified palette (`#F5F5F7`,
  `#FFFFFF`, `#1D1D1F`, `#6E6E73`, `#007AFF`, `#34C759`, `#FF9F0A`, `#FF3B30`, `#E5E5EA`). Where
  a base colour cannot carry text at WCAG AA (the accent reaches 4.0:1 on white), a darker
  `-text` or `-fill` variant is used for text and filled buttons. A unit test enforces contrast
  and forbids literal colours outside token files.
- **One component library** (`components/ui`) and one app shell: a collapsible sidebar with
  per-organization sections, a compact top bar with the account menu, and a drawer below 64rem.
  Pages compose components and add no CSS.
- **Platform primitives over custom widgets** where they are accessible by default: native
  `<dialog>` for modals and slide-overs, native date pickers, native selects (styled).
- **Theme preference** is a plain cookie (`eventhub_theme`), read on the server. The sidebar
  state is another (`eventhub_sidebar`). Neither holds personal data.
- **Route groups.** Signed-in pages live in `(app)` with the shell; signed-out pages in `(auth)`
  with a centred layout. URLs are unchanged.
- **No route-level loading UI.** A `loading.tsx` boundary would stream pages, which turns
  `notFound()` into a 200 response; cross-tenant pages must stay real 404s (T1). Navigation
  feedback comes from a spinner on the pending sidebar link instead.
- **Builder and microsites as patterns, not features.** The three-panel builder and the public
  microsite sections ship as design patterns in the gallery, with sample content. Saving and
  publishing stay disabled until the page, section and revision API exists (drafts and immutable
  published revisions remain separate concepts). Microsites read only `--site-*` tokens, so an
  event's identity is never constrained by the platform's look.
- **Gallery** at `/design-system`, on by default in development and off in production builds
  (`ADMIN_DESIGN_GALLERY`).

## Consequences

- New screens are faster to build and consistent by default; the checklist in
  `docs/design/design-system.md` is part of review.
- The navy/beige/gold palette is retired from the admin UI. The AW monogram stays as the logo, and
  a navy-and-gold preset is available for microsites.
- Per-event brand colours will need validation (format and contrast) when the builder stores them;
  the preset tests show the checks to apply.
- Browsers older than 2024 that lack `light-dark()` lose colours; supported browsers are current
  Chrome, Edge, Firefox and Safari 17.5+.
