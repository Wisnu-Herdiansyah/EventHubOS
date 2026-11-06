# Infrastructure as code

**Status: blocked on open decisions D1 (cloud/edge/certificates), D7 (regions/residency),
D8 (RPO/RTO), D5 (broker), D11 (cache).** See `docs/architecture/open-decisions.md`.

No Terraform is committed yet, deliberately: writing provider resources before the provider is
chosen would encode fabricated configuration.

When D1 is decided, add `infra/terraform/` with:

- `modules/` — network, managed PostgreSQL (HA per RPO/RTO, encrypted backups, PITR), Redis-
  compatible cache, object storage (private buckets, scan/quarantine prefixes), container
  services for `api`, `worker`, `migrate` (one-shot job), secret manager entries per workload.
- `envs/{staging,production}/` — separate accounts/projects, remote state with locking,
  least-privilege service identities, protected deploy approvals.
- CI: `terraform fmt -check`, `validate`, `plan` on PRs; `apply` only from protected branches.

Deployment order per release: `migrate` job (as `eventhub_migrator`) → `api`/`worker` rollout.
Migrations follow expand → migrate → contract so old and new application versions coexist.
