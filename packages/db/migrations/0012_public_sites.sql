-- Public event sites (ADR-0021, closes D6). Expand-only.
--
-- Address: https://{public_handle}.{platform domain}/{event slug}. The handle is unique across
-- the platform. Visitors are anonymous, so there is no tenant context: one SECURITY DEFINER
-- function resolves handle + slug and returns only what may be public: the latest *published
-- revision* of a page, for an event that is published, live or ended, whose visibility is public
-- or unlisted, in an active organization. Drafts are never read.

ALTER TABLE eventhub.organization
  ADD COLUMN public_handle text CHECK (public_handle ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$');
CREATE UNIQUE INDEX organization_public_handle_key ON eventhub.organization (public_handle);
GRANT UPDATE (public_handle) ON eventhub.organization TO eventhub_app;

CREATE FUNCTION eventhub.public_event_page(p_handle text, p_event_slug text)
  RETURNS TABLE (out_event_name text, out_starts_at timestamptz, out_ends_at timestamptz,
                 out_timezone text, out_venue_mode text, out_primary_language text,
                 out_lifecycle text, out_visibility text, out_sharing_title text,
                 out_sharing_description text, out_revision integer, out_sections jsonb,
                 out_schema_version integer, out_published_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT e.name, e.starts_at, e.ends_at, e.timezone, e.venue_mode, e.primary_language,
           e.lifecycle, coalesce(e.settings->>'visibility', 'public'),
           e.settings->'sharing'->>'title', e.settings->'sharing'->>'description',
           r.revision, r.sections, r.schema_version, r.published_at
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
      JOIN eventhub.event_page p
        ON p.organization_id = e.organization_id AND p.event_id = e.id AND p.page_key = 'home'
      JOIN eventhub.page_revision r
        ON r.organization_id = p.organization_id AND r.page_id = p.id
       AND r.revision = p.published_revision
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
  $$;

REVOKE ALL ON FUNCTION eventhub.public_event_page(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_event_page(text, text) TO eventhub_app;
