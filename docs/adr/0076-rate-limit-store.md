# ADR-0076: Shared rate limits in Memorystore for Valkey

- Status: accepted
- Date: 2026-11-26
- Closes: D11 (cache and rate-limit store)

## Context

Rate limits are counted per API instance today (`@fastify/rate-limit`, in memory). On Cloud Run
the API runs as several instances (ADR-0056), so each limit is effectively multiplied by the
number of instances, and a sign-in lockout on one instance is not seen by the others. Decided
with the product owner on 2026-11-26.

## Decision

- **Memorystore for Valkey** (Redis-compatible), in the same Google Cloud project and region
  as the API. Cloud Run reaches it over the private network through Direct VPC egress, so
  counters never cross the public internet
  ([Memorystore](https://cloud.google.com/memorystore)).
- It holds **rate-limit counters only** for now. Sessions, idempotency and the outbox stay in
  PostgreSQL. The store holds no personal data: keys are hashed client addresses and route
  names.
- **If the store is unreachable, limits fall back to per-instance counting** and the failure is
  logged. Requests are not refused because the store is down.
- Behind a port (`RateLimitStore`) with an in-memory adapter for local use and tests. The
  Valkey adapter must pass a shared contract.

Set aside: **Upstash Redis** (counters would go over the public internet to another provider)
and **PostgreSQL counters** (adds write load to Cloud SQL on every request).

## To build (later slice)

The port, the adapter, configuration, and the instance in `docs/operations/staging-setup.md`,
run by the product owner. The size and cost are confirmed when it is created.
