-- Event settings and lifecycle (EVT-02, EVT-03, EVT-05; ADR-0011).
-- Expand-only: new nullable/defaulted columns (metadata-only in PostgreSQL 11+) and a CHECK.

ALTER TABLE eventhub.event
  ADD COLUMN settings              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  ADD COLUMN settings_version      integer NOT NULL DEFAULT 1 CHECK (settings_version > 0),
  ADD COLUMN lifecycle_changed_at  timestamptz,
  ADD COLUMN archived_from         text CHECK (archived_from IN ('draft', 'scheduled', 'ended'));

-- An archived event always records where it came from (so restore is exact); others never do.
ALTER TABLE eventhub.event
  ADD CONSTRAINT event_archived_from_consistent
  CHECK ((lifecycle = 'archived') = (archived_from IS NOT NULL));

GRANT UPDATE (settings, settings_version, lifecycle_changed_at, archived_from) ON eventhub.event TO eventhub_app;

CREATE INDEX event_org_lifecycle_idx ON eventhub.event (organization_id, lifecycle, created_at DESC, id DESC);
