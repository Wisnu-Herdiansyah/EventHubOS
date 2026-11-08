-- Event microsite pages: an editable draft and immutable published revisions (ADR-0020).
-- Expand-only: two new tenant-owned tables with forced RLS.
--
-- Drafts and published revisions are separate. The draft lives on event_page and changes freely;
-- publishing copies it into page_revision, which the runtime role can insert and read but never
-- update or delete. Nothing here is publicly routable: public rendering (a later phase) will
-- read published revisions only.

CREATE TABLE eventhub.event_page (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES eventhub.organization (id),
  event_id                  uuid NOT NULL,
  page_key                  text NOT NULL DEFAULT 'home' CHECK (page_key ~ '^[a-z][a-z0-9-]{0,39}$'),
  draft_sections            jsonb NOT NULL CHECK (jsonb_typeof(draft_sections) = 'array'),
  draft_schema_version      integer NOT NULL CHECK (draft_schema_version > 0),
  draft_version             integer NOT NULL DEFAULT 1 CHECK (draft_version > 0),
  draft_updated_by          uuid NOT NULL REFERENCES eventhub.app_user (id),
  draft_updated_at          timestamptz NOT NULL DEFAULT now(),
  published_revision        integer CHECK (published_revision > 0),
  -- The draft version that the latest revision was published from ("unpublished changes").
  published_draft_version   integer CHECK (published_draft_version > 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, event_id) REFERENCES eventhub.event (organization_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, event_id, page_key),
  CHECK ((published_revision IS NULL) = (published_draft_version IS NULL))
);
CREATE TRIGGER event_page_tenant_immutable BEFORE UPDATE ON eventhub.event_page
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.event_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.event_page FORCE ROW LEVEL SECURITY;
CREATE POLICY event_page_tenant ON eventhub.event_page FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.event_page TO eventhub_app;
GRANT UPDATE (draft_sections, draft_schema_version, draft_version, draft_updated_by,
              draft_updated_at, published_revision, published_draft_version)
  ON eventhub.event_page TO eventhub_app;

CREATE TABLE eventhub.page_revision (
  organization_id   uuid NOT NULL REFERENCES eventhub.organization (id),
  page_id           uuid NOT NULL,
  revision          integer NOT NULL CHECK (revision > 0),
  sections          jsonb NOT NULL CHECK (jsonb_typeof(sections) = 'array'),
  schema_version    integer NOT NULL CHECK (schema_version > 0),
  draft_version     integer NOT NULL CHECK (draft_version > 0),
  published_by      uuid NOT NULL REFERENCES eventhub.app_user (id),
  published_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, revision),
  FOREIGN KEY (organization_id, page_id) REFERENCES eventhub.event_page (organization_id, id)
);
CREATE INDEX page_revision_org_page_idx ON eventhub.page_revision (organization_id, page_id, revision DESC);

ALTER TABLE eventhub.page_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.page_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY page_revision_tenant ON eventhub.page_revision FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
-- Immutable: no UPDATE or DELETE privilege for the runtime role.
GRANT SELECT, INSERT ON eventhub.page_revision TO eventhub_app;
