-- Audit log viewer (ADR-0013): keyset pagination and per-object history.
-- Expand-only. Plain CREATE INDEX briefly blocks writes to audit_event while it builds; the table
-- is small before launch. Later index additions on large tables must use a separate
-- CREATE INDEX CONCURRENTLY migration run outside a transaction.

CREATE INDEX audit_event_org_time_id_idx
  ON eventhub.audit_event (organization_id, occurred_at DESC, id DESC);

CREATE INDEX audit_event_org_target_idx
  ON eventhub.audit_event (organization_id, target_type, target_id, occurred_at DESC);
