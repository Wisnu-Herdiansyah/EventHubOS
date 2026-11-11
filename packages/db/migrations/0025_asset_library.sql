-- Asset library (ADR-0042). Expand-only.
--
-- Organizations upload images once and use them on their event pages (speaker photos first).
-- The bytes live in object storage behind the ObjectStore port; this table holds what the API
-- knows about each image. Every upload is re-encoded by the API (WebP, metadata stripped) before
-- it is stored, so the stored type is always image/webp.
--
-- Deleting an image is a soft delete: the row stays for the audit trail, and the worker removes
-- the bytes through the outbox. An image in use on a page cannot be deleted.

CREATE TABLE eventhub.asset (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES eventhub.organization (id),
  -- What the organizer calls it (the file name by default). One line of plain text.
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200
                                        AND name !~ '[[:cntrl:]]'),
  -- Text alternative for screen readers; empty when the image is decorative.
  alt_text         text NOT NULL DEFAULT '' CHECK (char_length(alt_text) <= 300
                                                    AND alt_text !~ '[[:cntrl:]]'),
  content_type     text NOT NULL CHECK (content_type = 'image/webp'),
  -- Of the large rendition.
  width            integer NOT NULL CHECK (width BETWEEN 1 AND 10000),
  height           integer NOT NULL CHECK (height BETWEEN 1 AND 10000),
  byte_size        integer NOT NULL CHECK (byte_size BETWEEN 1 AND 20000000),
  -- Prefix of the stored renditions (`<key>/large.webp`, `<key>/small.webp`). Server-generated.
  storage_key      text NOT NULL UNIQUE CHECK (storage_key ~ '^[a-z0-9-]+(/[a-z0-9-]+)*$'),
  sha256           bytea NOT NULL CHECK (octet_length(sha256) = 32),
  created_by       uuid NOT NULL REFERENCES eventhub.app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES eventhub.app_user (id),
  UNIQUE (organization_id, id),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE INDEX asset_org_live_created_idx
  ON eventhub.asset (organization_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER asset_tenant_immutable BEFORE UPDATE ON eventhub.asset
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.asset FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_tenant ON eventhub.asset FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.asset TO eventhub_app;
GRANT UPDATE (name, alt_text, updated_at, deleted_at, deleted_by) ON eventhub.asset TO eventhub_app;

-- Public: the storage key of an image, only while it appears in the current published revision
-- of a page that is itself public (same rules as public_event_page: an active organization, a
-- public or unlisted event that is published, live or ended). Drafts never make an image public.
-- "Appears" means some string value in the revision's sections equals the image ID, wherever an
-- image field is; image IDs are random UUIDs, so nothing else matches by accident.
CREATE FUNCTION eventhub.public_asset(p_handle text, p_asset_id uuid)
  RETURNS TABLE (out_storage_key text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT a.storage_key
      FROM eventhub.organization o
      JOIN eventhub.asset a
        ON a.organization_id = o.id AND a.id = p_asset_id AND a.deleted_at IS NULL
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND EXISTS (
         SELECT 1
           FROM eventhub.event e
           JOIN eventhub.event_page p
             ON p.organization_id = e.organization_id AND p.event_id = e.id
           JOIN eventhub.page_revision r
             ON r.organization_id = p.organization_id AND r.page_id = p.id
            AND r.revision = p.published_revision
          WHERE e.organization_id = o.id
            AND e.lifecycle IN ('published', 'live', 'ended')
            AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
            AND jsonb_path_exists(r.sections, '$.** ? (@ == $id)',
                                  jsonb_build_object('id', a.id::text))
       )
  $$;

REVOKE ALL ON FUNCTION eventhub.public_asset(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_asset(text, uuid) TO eventhub_app;
