-- Add to calendar (ADR-0048). Expand-only.
--
-- Public: what an iCalendar file of a public page needs, with the same visibility rules as
-- public_event_page (an active organization; a public or unlisted event that is published, live
-- or ended; a published page). The event ID is returned only so the API can derive a stable,
-- opaque calendar UID from it; the version becomes the file's SEQUENCE, so a calendar that
-- imports the file again replaces the entry instead of adding a second one.
CREATE FUNCTION eventhub.public_event_calendar(p_handle text, p_event_slug text)
  RETURNS TABLE (
    out_event_id uuid,
    out_version integer,
    out_updated_at timestamptz,
    out_event_name text,
    out_starts_at timestamptz,
    out_ends_at timestamptz,
    out_timezone text,
    out_venue_mode text,
    out_description text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT e.id, e.version, e.updated_at, e.name, e.starts_at, e.ends_at, e.timezone,
           e.venue_mode, e.settings->'sharing'->>'description'
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
      JOIN eventhub.event_page p
        ON p.organization_id = e.organization_id AND p.event_id = e.id AND p.page_key = 'home'
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
       AND p.published_revision IS NOT NULL
  $$;

REVOKE ALL ON FUNCTION eventhub.public_event_calendar(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_event_calendar(text, text) TO eventhub_app;
