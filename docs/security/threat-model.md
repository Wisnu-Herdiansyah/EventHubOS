# Threat model (Phase 0 / Phase 1 slice)

Scope: control-plane API, PostgreSQL, outbox relay. Method: STRIDE per trust boundary.
Revisit when adding public delivery (Phase 2), domains (Phase 3), billing/webhooks (Phase 4).

## Assets

Tenant business data; membership/role assignments; session tokens; audit evidence;
database credentials; outbox payloads.

## Trust boundaries

1. Internet → API (untrusted clients). 2. API → PostgreSQL (runtime role). 3. Worker →
   PostgreSQL and broker. 4. Operators → migration/bootstrap roles.

## Threats and mitigations

| ID  | STRIDE          | Threat                                                                   | Mitigation (implemented)                                                                                                          | Residual / follow-up                                                      |
| --- | --------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| T1  | Elevation       | Cross-tenant read/write via guessed or swapped org/event IDs (IDOR/BOLA) | Membership-resolved context; uniform 404; object-level tenant predicate; RLS forced on all tenant tables; tests + mutation checks | Extend isolation suite to cache, assets, search, queues as they are built |
| T2  | Elevation       | Service-layer bug omits tenant filter                                    | RLS with fail-closed missing context; runtime role `NOBYPASSRLS`, non-owner                                                       | Policy correctness relies on review for new tables                        |
| T3  | Tampering       | Moving rows between tenants                                              | No UPDATE grant on `organization_id`; trigger guard                                                                               | —                                                                         |
| T4  | Repudiation     | Actor denies a change; audit altered                                     | Append-only `audit_event` (triggers block even owner); correlation IDs                                                            | Off-database audit archive and integrity hashing before GA                |
| T5  | Spoofing        | Stolen/forged session token                                              | 256-bit random tokens, SHA-256 at rest, expiry/revocation checked in DB; strict bearer format                                     | MFA, rotation, device binding depend on D3                                |
| T6  | Info disclosure | Secrets/PII in logs or errors                                            | Pino redaction; generic 500 bodies; ConfigError omits values                                                                      | Log PII scanning in staging                                               |
| T7  | Tampering       | Duplicate side effects from retries/races                                | Idempotency keys in-transaction; outbox + consumer dedupe                                                                         | Outbox/idempotency retention jobs (D9)                                    |
| T8  | DoS             | Request floods, large bodies, slow queries                               | Rate limit (per instance), 64 KiB body limit, statement timeout, pool limits                                                      | Distributed rate limit (D11), WAF (D1), per-tenant quotas                 |
| T9  | Elevation       | Privilege escalation via role assignment                                 | `canAssignRole` (no granting above own authority; only Owner grants Owner) — catalogue-tested                                     | Wire into invitation endpoints (next slice)                               |
| T10 | Tampering       | Unsafe migration weakens isolation or destroys data                      | `db:check` lint; checksums; advisory lock; lock timeout                                                                           | Staging run against production-like volume (pre-prod gate 1)              |
| T11 | Info disclosure | Worker reads tenant data broadly                                         | Worker role limited to outbox delivery columns and dedupe ledger                                                                  | Consumers that act on tenant data need scoped roles                       |
| T12 | Spoofing        | Malicious correlation ID header for log injection                        | Strict charset/length; otherwise regenerated                                                                                      | —                                                                         |
