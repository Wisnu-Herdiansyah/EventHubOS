# ADR-0052: Singapore as the region (closes D7)

- Status: accepted
- Date: 2026-11-12
- Decision owner: product owner (D7 in `docs/architecture/open-decisions.md`)
- Builds on: ADR-0051 (Google Cloud)
- Leaves open: D8 (RPO and RTO), D10 (legal artefacts), D11 (cache store)

## Decision

All EventHub OS data is stored and processed in **Singapore**, Google Cloud region
`asia-southeast1`, for every environment (staging and production).

| Resource                      | Location                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| Cloud Run services (all four) | `asia-southeast1`                                                          |
| Cloud SQL for PostgreSQL 16   | `asia-southeast1`, high availability across zones in the region            |
| Cloud SQL backups and exports | `asia-southeast1` (a custom backup location, not the default multi-region) |
| Cloud Storage image buckets   | Regional, `asia-southeast1`                                                |
| Secret Manager secrets        | Replication limited to `asia-southeast1` (user-managed replication)        |
| Logs (Cloud Logging buckets)  | `asia-southeast1`                                                          |

To be enforced with the organization policy `constraints/gcp.resourceLocations`, limited to
`asia-southeast1`, on the project, so a resource cannot be created elsewhere by mistake.

## What leaves the region, and why

- **Cloud CDN edge caches.** Public event pages and images that are already public may be cached
  at Google's edge worldwide, as with any CDN. The admin app and the API are not cached, and no
  personal data is cached.
- **Email.** Transactional email goes through the email provider (ADR-0008). Recipient addresses
  and message contents are processed wherever that provider runs. This decision does not change
  that. Whether it is acceptable belongs with the legal review (D10). Nothing here makes a legal
  or compliance claim.
- **The global load balancer's control plane** is global by design. The data it serves comes from
  the regional services.

## Consequences

- Staging infrastructure as code is no longer blocked by a decision. It now needs only the real
  project, billing account and domain identifiers, which come from the product owner. They are not
  invented in this repository.
- The database, image and backup locations are fixed. Moving region later means a migration
  project, not a configuration change.
- Recovery objectives (D8) are still open. Cross-region disaster recovery would move copies out of
  Singapore and would need a new decision.
