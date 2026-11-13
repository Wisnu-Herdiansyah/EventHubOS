# ADR-0055: Region chosen for speed (replaces ADR-0052, reopens nothing)

- Status: accepted
- Date: 2026-11-12
- Decision owner: product owner (D7). Replaces ADR-0052 (all data in Singapore)
- Builds on: ADR-0054 (hybrid platform)

## Decision

**Supabase picks the database region, for the fastest access.** When the project is created, the
recommended region Supabase offers is accepted as it is. Everything else then follows that region.

| Piece                               | Region                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| Supabase project (Postgres, images) | The region Supabase recommends at project creation         |
| Vercel Functions (API, admin, site) | The Vercel Functions region closest to the Supabase region |
| Worker (Cloud Run)                  | The Cloud Run region closest to the Supabase region        |
| Pages, images, static files         | Served from Vercel's global edge network, unchanged        |

### Why "follows the database" is the rule

Most of a request's time is spent between the API and the database: one page can need several
queries, and each one crosses that distance. The distance from a visitor to the API is crossed
once, and much of what visitors load already comes from the edge. So the fastest setup is the API
and worker sitting next to the database, wherever it is. A database "close to users" with functions
in another region would be slower than both being together somewhere else.

### Recording the outcome

The region Supabase picks is a one-time choice. Moving a database later means a migration, not a
setting. The verification checklist (`docs/operations/hybrid-platform-verification.md`) records:

- the region Supabase picked;
- the Vercel and Cloud Run regions chosen to match it;
- the measured API-to-database round trip.

The checklist results are copied into this ADR once known.

### Outcome so far (2026-11-12)

- **Region: Singapore (`ap-southeast-1`), chosen by the product owner.** Supabase's API has no
  "recommended region" option: a region must be named. The recommendation exists only in the
  dashboard, so the product owner named Singapore.
- **Supabase was dropped (ADR-0056).** Its free plan was at the limit of two active projects, and
  the product owner chose their Firebase (Google Cloud) project instead. The database is Cloud SQL
  in `asia-southeast1`; the API and worker run next to it, as this ADR requires.
- **Postgres 17.** Checked while Supabase was the plan (its projects run PostgreSQL 17; CI runs
  16, and Cloud SQL will run 16). The full
  integration suite passes on PostgreSQL 17.11 locally (408 of 408), including bootstrap, all
  migrations, row-level security and tenant isolation.

## Consequences

- **No data-residency guarantee.** ADR-0052 kept every copy of the data in Singapore. That rule is
  dropped at the product owner's request. The data lives in whichever region Supabase picks, plus
  the providers' own logs and backups in their usual locations.
  - If a customer contract or the legal review (D10) later requires a country, the region becomes a
    constraint again. Satisfying it would mean moving the database.
- Hosting no longer depends on a decision. It still needs the real project, billing and domain
  identifiers.
- Container images are unaffected (ADR-0053). The registry region, when there is one, follows the
  worker's region.

## Alternatives

- **Keep Singapore (ADR-0052).** It guarantees where the data is, at the cost of choosing for
  residency rather than speed. Replaced at the product owner's request. For organizers and attendees
  mostly in Southeast Asia, Supabase will likely recommend Singapore anyway; then this ADR changes
  nothing in practice except dropping the guarantee.
- **Read replicas in several regions.** They are faster for reads far from the main region, but
  writes still go to one place, and tenants' data would be copied to more locations. Not needed
  before there is traffic to measure.
