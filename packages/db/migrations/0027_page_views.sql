-- Page-view counts for public event pages (ADR-0044). Expand-only.
--
-- One counter per event per calendar day (in the event's time zone). Nothing about the visitor
-- is stored: no IP address, user agent, cookie, referrer or time of day. The public site counts a
-- view after it has served a published page; the counts are approximate by design.

CREATE TABLE eventhub.event_page_view_day (
  organization_id  uuid NOT NULL,
  event_id         uuid NOT NULL,
  day              date NOT NULL,
  views            bigint NOT NULL CHECK (views > 0),
  PRIMARY KEY (organization_id, event_id, day),
  FOREIGN KEY (organization_id, event_id) REFERENCES eventhub.event (organization_id, id)
);
CREATE TRIGGER event_page_view_day_tenant_immutable BEFORE UPDATE ON eventhub.event_page_view_day
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.event_page_view_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.event_page_view_day FORCE ROW LEVEL SECURITY;
CREATE POLICY event_page_view_day_tenant ON eventhub.event_page_view_day FOR SELECT TO eventhub_app
  USING (organization_id = eventhub.current_organization_id());
-- Reports read under tenant RLS; counting goes only through the function below.
GRANT SELECT ON eventhub.event_page_view_day TO eventhub_app;

-- Public: counts one view of an event's public page, today in the event's time zone. Counts only
-- what anyone can see (the same rules as public_event_page: an active organization, a public or
-- unlisted event that is published, live or ended, with a published page). Returns whether it
-- counted.
CREATE FUNCTION eventhub.record_public_page_view(p_handle text, p_event_slug text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_org uuid;
    v_event uuid;
    v_tz text;
  BEGIN
    SELECT e.organization_id, e.id, e.timezone INTO v_org, v_event, v_tz
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
      JOIN eventhub.event_page p
        ON p.organization_id = e.organization_id AND p.event_id = e.id AND p.page_key = 'home'
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
       AND p.published_revision IS NOT NULL;
    IF v_event IS NULL THEN
      RETURN false;
    END IF;
    INSERT INTO eventhub.event_page_view_day AS v (organization_id, event_id, day, views)
    VALUES (v_org, v_event, (now() AT TIME ZONE v_tz)::date, 1)
    ON CONFLICT (organization_id, event_id, day) DO UPDATE SET views = v.views + 1;
    RETURN true;
  END $$;

REVOKE ALL ON FUNCTION eventhub.record_public_page_view(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.record_public_page_view(text, text) TO eventhub_app;
