# ADR-0046: Sharing image and page theme

- Status: accepted
- Date: 2026-11-12
- Builds on: ADR-0011 (event settings), ADR-0019 (design system), ADR-0021 (public sites),
  ADR-0042 (asset library)
- Threat model: T69 (updated)

## Decision

Organizers can give an event's public page **colours** and a **sharing image**.

### Theme

- `settings.theme` is one of `EVENT_THEMES` (`packages/kernel`): `default` (the platform blue),
  `navy-gold`, `forest` or `ember`.
- These are the microsite presets that were already contrast-checked (ADR-0019). Organizers
  choose one; nobody types colours, so a page cannot become unreadable.
- Unset means `default`. The admin clears the setting rather than storing `default`.
- Tests keep three things in step:
  - the CSS presets and the theme list;
  - the admin's swatches and the preset colours;
  - every preset and WCAG contrast (existing test).
- The public site renders `data-brand` from the theme. The page editor's preview uses the same
  theme, so the preview still matches the published page.

### Sharing image

- `settings.sharing.imageAssetId` names an image from the organization's library.
- Saving checks that the image is a live image of the same organization, and locks it until
  commit (as page images do), so a concurrent delete cannot slip through.
- The public page adds `og:image` and a large Twitter card. Both use the absolute address
  `https://{handle}.{domain}/images/{id}/large.webp` on the event's own site: link previews
  fetch from there, and no third-party host is involved.
- **Public serving widens by exactly one case.** `public_asset` (migration 0029) also serves an
  image while it is the sharing image of a public page. The rules are those of the published
  page: an active organization, a public or unlisted event that is published, live or ended,
  and a published page. A private or unpublished event's sharing image stays private, and so
  does every other library image.
- **Deleting is refused** while any event uses the image as its sharing image (`asset_in_use`).
- The public page's theme and image come from a new definer function,
  `public_event_presentation`, with the same visibility rules. `public_event_page` keeps its
  shape.

## Alternatives

- **Custom brand colours (a colour picker).** It needs automatic contrast correction and a
  design review of every combination. Presets cover the need now; custom colours can come later
  behind the same contrast checks.
- **A separate image only for sharing, uploaded per event.** That would duplicate the library
  for no gain.
- **Generating a sharing image (event name over a background).** It needs a rendering service,
  and organizers usually have artwork already.
- **WebP or a separate JPEG for previews.** WebP is what the library stores, and the major
  preview services read it. A JPEG rendition can be added if one turns out to need it.

## Consequences

- Images are public in one more case, decided only by the organizer's own settings and the
  same visibility rules as pages.
- Sharing images are fetched by preview bots; their requests are not counted as page views
  (ADR-0044).
