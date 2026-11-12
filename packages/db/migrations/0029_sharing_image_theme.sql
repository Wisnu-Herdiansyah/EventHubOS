-- Sharing image and theme (ADR-0046). Expand-only.
--
-- An event can name a library image (ADR-0042) to show when its page is shared, and a colour
-- theme from tested presets. Both live in event settings (`sharing.imageAssetId`, `theme`).

-- Public: the theme and sharing image of a public page, with the same visibility rules as
-- public_event_page (an active organization; a public or unlisted event that is published, live
-- or ended; a published page). A new function, so public_event_page keeps its shape.
CREATE FUNCTION eventhub.public_event_presentation(p_handle text, p_event_slug text)
  RETURNS TABLE (out_theme text, out_sharing_image_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT coalesce(e.settings->>'theme', 'default'),
           (SELECT a.id FROM eventhub.asset a
             WHERE a.organization_id = e.organization_id AND a.deleted_at IS NULL
               AND a.id::text = e.settings->'sharing'->>'imageAssetId')
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

-- As in 0025, plus: an image is also public while it is the sharing image of a public page,
-- because link previews (chat apps, social networks) fetch it from the event's own address.
CREATE OR REPLACE FUNCTION eventhub.public_asset(p_handle text, p_asset_id uuid)
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
            AND (jsonb_path_exists(r.sections, '$.** ? (@ == $id)',
                                   jsonb_build_object('id', a.id::text))
                 OR e.settings->'sharing'->>'imageAssetId' = a.id::text)
       )
  $$;

REVOKE ALL ON FUNCTION eventhub.public_event_presentation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_event_presentation(text, text) TO eventhub_app;
