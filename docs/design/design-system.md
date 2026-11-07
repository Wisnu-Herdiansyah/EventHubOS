# EventHub OS design system

An original design system that follows the principles of Apple's platforms: clarity, deference,
depth, consistency and simplicity. It copies no Apple assets, icons, logos or layouts. Decision
record: [ADR-0019](../adr/0019-design-system.md).

- Live reference: `/design-system` in the admin app (on in development; see `ADMIN_DESIGN_GALLERY`).
- Source: `apps/admin/src/styles/` (tokens and styles), `apps/admin/src/components/ui/`
  (components), `apps/admin/src/components/shell/` (app shell), `apps/admin/src/components/patterns/`
  (builder and microsite).

## 1. Audit of the previous UI (before this change)

| Finding                                                                  | Resolution                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| One 700-line stylesheet; colours repeated as literals (`#8a93a8`, …)     | Split into tokens, base, components, shell, patterns            |
| Three list styles doing one job (`.list`, `.member-list`, `.audit-list`) | One grouped list (`.list`) and one `DataTable`                  |
| Badge colours repeated per status class (`.badge.pending`, `.accepted`)  | `Badge` with five tones; `lib/status.ts` maps states to tones   |
| `.message` variants hand-built per page; pages wrote their own headers   | `Notice`, `PageHeader`, `Card`                                  |
| `.narrow` and `.narrow-card`, `.actions` and `.inline-form` overlaps     | Layout helpers `stack`, `grid`, `grid-main-aside`, `form__*`    |
| Destructive actions in `<details>` disclosures                           | Native `<dialog>` confirmations                                 |
| No dark mode, no app navigation, section links repeated on pages         | Light/dark tokens, sidebar shell with per-organization sections |

## 2. Tokens (`styles/tokens.css`)

Every colour is a `light-dark(light, dark)` pair. The scheme follows the system; Account →
Appearance can force light or dark (cookie `eventhub_theme`, read on the server so the first
paint is right).

| Token                    | Light     | Dark      | Use                                   |
| ------------------------ | --------- | --------- | ------------------------------------- |
| `--color-bg`             | `#F5F5F7` | `#000000` | Page background                       |
| `--color-surface`        | `#FFFFFF` | `#1C1C1E` | Cards, sidebar                        |
| `--color-text`           | `#1D1D1F` | `#F5F5F7` | Primary text                          |
| `--color-text-secondary` | `#6E6E73` | `#98989D` | Secondary text                        |
| `--color-accent`         | `#007AFF` | `#0A84FF` | Focus ring, selection, icons, charts  |
| `--color-accent-text`    | `#0066CC` | `#409CFF` | Links and accent text                 |
| `--color-accent-fill`    | `#0066CC` | `#0071E3` | Filled buttons                        |
| `--color-success`        | `#34C759` | `#30D158` | Dots and icons (`-text` for text)     |
| `--color-warning`        | `#FF9F0A` | `#FF9F0A` | Dots and icons (`-text` for text)     |
| `--color-danger`         | `#FF3B30` | `#FF453A` | Dots and icons (`-text`, `-fill`)     |
| `--color-divider`        | `#E5E5EA` | `#38383A` | Separators                            |
| `--color-border-control` | `#86868B` | `#8E8E93` | Input borders (3:1 non-text contrast) |

**Why some text uses a darker variant.** The base accent `#007AFF` reaches only 4.0:1 on white,
and the base success, warning and danger colours less. They stay the brand of the system (focus
rings, icons, chart marks, which need 3:1) while text and filled buttons use the `-text` and
`-fill` variants that reach 4.5:1. `src/styles/tokens.test.ts` checks every pairing the
components use, in both schemes, and fails the build if a stylesheet other than a token file
contains a literal colour.

Other tokens: type scale 12/13/15/17/22/28/40 px on the system font stack (`-apple-system`,
`BlinkMacSystemFont`, `SF Pro`, then `Helvetica Neue`, `system-ui`, `Segoe UI`, `Roboto`; SF Pro is
not shipped, for licensing); a 4px spacing grid; radii 6/10/14 px; two shadows plus one for
overlays; motion 120/200/280 ms with one easing curve, all zero under `prefers-reduced-motion`.

## 3. Components

| Component                | File                                   | Notes                                                               |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------- |
| Sidebar, top bar, drawer | `shell/app-shell.tsx`                  | Rail collapse remembered (cookie); drawer below 64rem               |
| Page header, breadcrumbs | `ui/page-header.tsx`                   | One heading pattern for every page                                  |
| Buttons                  | `ui/button.tsx`                        | primary, secondary, plain, danger, danger-secondary; sm             |
| Inputs, select, date     | `form.tsx`                             | Labels, hints, errors wired with `aria-describedby`                 |
| Search field             | `ui/search-field.tsx`                  | Visually hidden label; `role="search"`                              |
| Dropdown menu            | `ui/menu.tsx`                          | WAI-ARIA menu button: arrows, Home/End, Escape                      |
| Cards, stats             | `ui/card.tsx`                          | Every titled card is a named region                                 |
| Data table               | `ui/data-table.tsx`                    | Rows stack into labelled cards under 40rem                          |
| Tabs                     | `ui/tabs.tsx`                          | Automatic activation; tab kept in the URL fragment                  |
| Modal dialog, slide-over | `ui/dialog.tsx`                        | Native `<dialog>`: focus trap, Escape, focus return                 |
| Status badge             | `ui/badge.tsx`                         | Text carries meaning; colour and dot reinforce                      |
| Notice, toast            | `ui/notice.tsx`, `ui/toast.tsx`        | Alerts for errors, polite status otherwise; toast has no time limit |
| Empty state, loading     | `ui/empty-state.tsx`, `ui/loading.tsx` | Spinner with label; skeletons hidden from AT                        |
| Tooltip                  | `ui/tooltip.tsx`                       | Hover and focus; Escape dismisses (WCAG 1.4.13)                     |
| Date picker              | `form.tsx` (`date`, `datetime-local`)  | Native control, styled: platform calendar and keyboard support      |
| Charts                   | `ui/chart.tsx`                         | Bar chart is a real table with drawn bars; meter                    |
| Theme picker             | `ui/theme-picker.tsx`                  | Segmented control (radio group)                                     |

**Interaction rules.** Hover feedback within 120 ms; one focus ring everywhere (3px accent,
2px offset); pressed buttons scale to 98%; disabled at 50% opacity. Creation forms open in a
slide-over from the page header, except on first use, where the empty state sits beside the
form so there is one obvious next step. Destructive actions confirm in a dialog whose button
names the consequence ("Remove name@example.com").

**Constraints from the security model.** The Content Security Policy blocks inline styles, so
components never use `style=`; sizes that depend on data (chart bars, meters) are SVG
attributes. No web fonts are loaded (`font-src 'self'`).

## 4. Patterns

**Microsite builder** (`patterns/builder.tsx`, shown in the gallery with sample content): toolbar
(undo/redo, preview size, save draft, publish), section navigator (select, move up/down, show/
hide, duplicate), live preview, configuration panel. Undo/redo keeps 50 steps
(`builder-history.ts`, unit-tested). Saving and publishing are disabled until the page and
revision API exists; sections are typed and versioned (`SectionInstance`, `version: 1`) and
render plain text only, never tenant HTML or script.

**Public microsites** (`styles/site-tokens.css`, `styles/microsite.css`): editorial sections
(navigation, hero, text, agenda, speakers, registration call to action, footer) that read only
`--site-*` tokens, so each event brings its own colours, type and corner radius. Layout uses
container queries, so the same sections fit a phone, a tablet and the builder preview. Four
presets stand in for per-event themes; each is contrast-checked in the unit tests.

## 5. Visual consistency checklist

Use for every new screen or component; reviewers check it on pull requests.

- [ ] Uses `PageHeader`, `Card`, and existing components; no page-specific CSS.
- [ ] Colours, spacing, radii, shadows and durations come from tokens only.
- [ ] Looks right in light and dark mode (gallery theme picker or Account → Appearance).
- [ ] No horizontal scrolling at 360, 430, 768, 1024, 1280 and 1440 px.
- [ ] Touch targets ≥ 44px for primary controls, ≥ 32px for compact ones.
- [ ] Every control has a visible label or a visually hidden one that starts with the visible text.
- [ ] Status is never conveyed by colour alone.
- [ ] Keyboard: reachable in order, visible focus, Escape closes overlays, focus returns.
- [ ] Errors are alerts tied to fields; confirmations are polite status messages.
- [ ] Motion is subtle and disappears with reduced motion.
- [ ] Empty, loading and error states are designed, not left blank.
- [ ] axe passes (`expectAccessible`) in both colour schemes.

## 6. How it is verified

- `src/styles/tokens.test.ts`: WCAG contrast for every token pairing in light and dark, the
  base palette from the specification, no literal colours outside token files, microsite presets.
- `e2e/design-system.spec.ts`: axe on every major screen in light and dark; no horizontal overflow
  at six widths; sidebar rail and phone drawer; menu, tabs, dialogs, slide-over and toast from the
  keyboard; reduced motion; builder interactions.
- Every existing end-to-end journey runs on the new shell.
