# ADR-0051: Google Cloud as the platform (closes D1)

- Status: replaced by ADR-0054 (hybrid: Vercel, Supabase, Cloud Run for the worker). The Cloud
  Storage adapter stays available
- Date: 2026-11-12
- Decision owner: product owner (D1 in `docs/architecture/open-decisions.md`)
- Builds on: ADR-0042 (asset library and the `ObjectStore` port)
- Leaves open: D8 (RPO and RTO), D11 (cache and rate-limit store). Region: ADR-0052 (Singapore)

## Decision

EventHub OS runs on **Google Cloud**. The product owner chose Google Cloud after a first request
for "Google Drive", which cannot host applications or serve as a CDN, firewall or certificate
provider.

| Concern                         | Google Cloud service                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| API, worker, admin, public site | Cloud Run (containers; one service each, the worker with CPU always on)     |
| PostgreSQL 16                   | Cloud SQL for PostgreSQL 16, private IP, TLS required (already enforced)    |
| Edge, CDN, firewall             | External Application Load Balancer with Cloud CDN and Cloud Armor           |
| Managed certificates            | Certificate Manager (platform domain now; organizers' custom domains later) |
| Uploaded images                 | Cloud Storage, a private bucket per environment (built in this change)      |
| Secrets                         | Secret Manager, given to Cloud Run as environment variables at deploy       |
| Identity of services            | One service account per service, with least privilege; no key files         |

### Built in this change

- **`CloudStorageObjectStore`** (`@eventhub/kernel/gcs-object-store`) behind the existing
  `ObjectStore` port:
  - the official SDK (`@google-cloud/storage` 8.4.0, pinned) sits behind a three-method
    `BucketClient`, so domain code never sees the SDK;
  - keys are validated before any call, as in every adapter;
  - uploads are single requests, never public, and sent with `Cache-Control: private, no-store`;
  - a missing object reads as `null` and deletes as success; every other error propagates.
- **Configuration:**
  - `OBJECT_STORE=gcs` with `GCS_BUCKET`, a validated bucket name;
  - `gcs` is the only object store accepted in staging and production, and the local adapters are
    still refused there;
  - credentials come from Application Default Credentials, meaning the service account the
    service runs as. No key, path or JSON is read from configuration.
- **Tests:**
  - the shared `ObjectStore` contract runs against the adapter with an in-memory bucket;
  - the SDK glue is checked against a stand-in SDK (request options, not-found handling, error
    propagation, bucket-name validation);
  - `pnpm test:live` runs the same contract against a real bucket when `GCS_CONTRACT_BUCKET` and
    Application Default Credentials are present, and otherwise skips.

### The bucket stays private

The API reads images and serves them under its own rules (ADR-0042, ADR-0046). Public pages get
them through the site. The bucket needs:

- uniform bucket-level access and public access prevention;
- `roles/storage.objectAdmin` for the API's and worker's service accounts, on this bucket only.

## Not done here, and why

- **Infrastructure as code** (`infra/`). It needs the region (D7) and the real project, billing
  and domain identifiers. Writing it now would mean inventing them.
- **Custom domains.** The platform is now chosen: Certificate Manager and the load balancer. The
  feature is still to be built, after the staging infrastructure.
- **Cache and rate-limit store.** Memorystore is the natural fit on Google Cloud, but D11 stays
  open until multi-instance staging shows the need.

## Alternatives

- **Google Drive.** It is a file-sharing service for people: every file belongs to an account and
  is governed by OAuth, with per-user quotas and rate limits. It is not built for serving
  application assets, and it cannot host, cache, protect or certify anything.
- **AWS or Azure.** Equivalent capabilities. The product owner chose Google Cloud.
- **Cloudflare in front of Google Cloud.** It would split the edge from the platform. It is
  possible later if a need appears; Cloud CDN and Cloud Armor cover the first release.
- **Signed URLs straight from the bucket.** They would bypass the API's per-request visibility
  rules for images (ADR-0046). Serving through the API keeps a single access check.

## Consequences

- Staging can store images in Cloud Storage as soon as a bucket and a service account exist.
- The next platform step is the staging IaC, which waits for the region (D7).
