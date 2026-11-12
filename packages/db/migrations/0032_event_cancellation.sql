-- Event cancellation (ADR-0050). Expand-only.
--
-- An organizer cancels an event that is scheduled, published or live. The event keeps its
-- lifecycle, so its public page stays reachable and can say it is cancelled. Cancellation is
-- final: registration stays closed, nobody is promoted from the waitlist, and the calendar file
-- says CANCELLED under the same UID.

ALTER TABLE eventhub.event
  ADD COLUMN cancelled_at        timestamptz,
  ADD COLUMN cancelled_by        uuid REFERENCES eventhub.app_user (id),
  ADD COLUMN cancellation_reason text
    CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) BETWEEN 1 AND 2000),
  ADD CONSTRAINT event_cancellation_complete
    CHECK ((cancelled_at IS NULL) = (cancellation_reason IS NULL)
           AND (cancelled_at IS NULL) = (cancelled_by IS NULL));

-- As in 0014, plus: a cancelled event's registration is 'cancelled', whatever else is set. Every
-- sign-up path (public_register, public_register_with_answers), the public state and waitlist
-- promotion (fill_waitlist accepts only 'open' and 'full') go through this function.
CREATE OR REPLACE FUNCTION eventhub.registration_state(p_event eventhub.event, p_confirmed bigint,
                                                       p_now timestamptz)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT CASE
      WHEN p_event.cancelled_at IS NOT NULL THEN 'cancelled'
      WHEN p_event.lifecycle NOT IN ('published', 'live') THEN 'closed'
      WHEN (p_event.settings->'registration'->>'opensAt') IS NOT NULL
           AND p_now < (p_event.settings->'registration'->>'opensAt')::timestamptz THEN 'not_open_yet'
      WHEN p_now >= coalesce((p_event.settings->'registration'->>'closesAt')::timestamptz, p_event.ends_at)
        THEN 'closed'
      WHEN (p_event.settings->'registration'->>'capacity') IS NOT NULL
           AND p_confirmed >= (p_event.settings->'registration'->>'capacity')::bigint THEN 'full'
      ELSE 'open'
    END
  $$;

-- Public: whether a public page's event is cancelled, and the organizer's reason. Same visibility
-- rules as public_event_page; a new function, so the page and calendar functions keep their shape.
CREATE FUNCTION eventhub.public_event_cancellation(p_handle text, p_event_slug text)
  RETURNS TABLE (out_cancelled_at timestamptz, out_reason text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT e.cancelled_at, e.cancellation_reason
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

REVOKE ALL ON FUNCTION eventhub.public_event_cancellation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_event_cancellation(text, text) TO eventhub_app;

-- The API cancels under tenant RLS: exactly these columns, nothing else.
GRANT UPDATE (cancelled_at, cancelled_by, cancellation_reason) ON eventhub.event TO eventhub_app;
-- Cancelling tells waitlisted people in its own email, so it marks them as told (ADR-0038).
GRANT UPDATE (waitlist_closed_at) ON eventhub.registration TO eventhub_app;
