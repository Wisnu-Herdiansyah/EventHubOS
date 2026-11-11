# ADR-0044: Page-view analytics

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0021 (public sites), ADR-0030 and ADR-0032 (reports)
- Threat model: T73

## Decision

Organizers see how often each event's public page was viewed: a total and views by day in the
event report, and a total and a per-event column (also in the CSV) in the organization report.

**Privacy first.** Only one number per event per day is stored. Nothing about the visitor is
kept anywhere:

- no cookie or browser storage;
- no script in the visitor's browser;
- no IP address, user agent, referrer or time of day.

Because of that, the counts are **views, not visitors**, and they are approximate. The page says
so.

### Counting

1. The public site server renders a published page.
2. If the request is a person's full page load, the site calls the API **after** the response
   has been sent, using Next.js `after()`. The page never waits for counting, and failures are
   ignored.
3. `POST /v1/public/sites/:handle/events/:eventSlug/views` runs `record_public_page_view`. That
   definer function counts only what anyone can see, using the same rules as
   `public_event_page`: an active organization, and a public or unlisted event that is
   published, live or ended, with a published page. It adds one to today's counter in the
   event's time zone. Anything else answers 404 and counts nothing.

Requests that do not count (`countsAsView`, unit-tested):

| Skipped                                                 | How it is recognised                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Prefetch and prerender                                  | `Purpose`, `Sec-Purpose`, `Next-Router-Prefetch`                                                                           |
| Form submissions and in-page refreshes                  | `Next-Action`, `RSC`                                                                                                       |
| Non-document fetches                                    | `Sec-Fetch-Dest` other than `document`                                                                                     |
| Crawlers, link-preview bots, headless browsers, scripts | User agent missing, very short, or matching a list (bot, crawl, spider, preview, headless, curl, social link expanders, …) |

**Limiting inflation.** The count route allows **30 requests per minute per visitor**. The site
passes the visitor's address only so the API can apply that limit; the address is not stored.
Edge limits and bot management belong to the CDN (D1).

### Storage

- `event_page_view_day (organization_id, event_id, day, views)` is tenant-owned with forced RLS.
- The runtime role can **read** it (for reports, under tenant context) but not write it. Writes
  go only through the definer function, as one upsert per view.
- **Day** is the calendar date in the event's time zone, like the rest of the event report.
  The organization report's period selects events by start date (ADR-0034), and their views
  come with them.

### Reports

| Report              | Page views shown                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event report        | `totals.pageViews`, and `pageViewsByDay` from the first day with views to the last (gaps are zeros, newest 366); a stat and a chart (by week beyond a month) |
| Organization report | `totals.pageViews` and per-event `pageViews`; a stat, a table column and a CSV column                                                                        |

Reading needs `report.read`, as before.

## Alternatives

- **A third-party analytics script.** Richer data, but it sends every visitor to another
  company and needs a cookie banner in many places. The site's CSP stays closed to it.
- **Unique visitors from a daily salted hash of IP and user agent.** Better numbers, but it
  still processes personal data for every visit. Views are enough to answer "is anyone looking
  at my page", and conversion can come from registrations.
- **Counting in the API's page lookup.** That lookup also serves metadata and runs for
  prefetches; it cannot tell a person's page load from anything else. The site server can.
- **Batching views in memory before writing.** Fewer writes on popular pages, but views are lost
  on restart. One upsert per view is simple; revisit if a single event's row becomes hot.

## Consequences

- Each counted view is one small database write. Very popular pages will need batching or a
  counter service later.
- A determined actor rotating addresses can still inflate counts within the rate limits. The
  numbers are labelled approximate and are not used for billing or decisions that need
  accuracy.
- Retention of daily counts can follow the event (D9). The counts contain no personal data.
