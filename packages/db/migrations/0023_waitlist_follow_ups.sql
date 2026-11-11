-- Waitlist follow-ups (ADR-0038). Expand-only.
--
-- 1. An optional cap on the waitlist (`registration.waitlistLimit`): once that many people are
--    waiting, the event answers "full" as it did before waitlists.
-- 2. Closing the waitlist: when registration closes (its closing time, the end of the event, or
--    the event ending or being archived), everyone still waiting is told once that no seat
--    became free. They stay `waitlisted` (they never had a seat, so reports are unchanged) but
--    are marked `waitlist_closed_at` and leave the queue: a seat freed later never goes to
--    someone who was told the waitlist closed.

ALTER TABLE eventhub.registration ADD COLUMN waitlist_closed_at timestamptz;

-- The open waitlist of each event, in joining order.
CREATE INDEX registration_event_open_waitlist_idx
  ON eventhub.registration (event_id, created_at, id)
  WHERE status = 'waitlisted' AND waitlist_closed_at IS NULL;

-- Whether a full event still takes people onto its waitlist: the setting is on, and the open
-- waitlist is below its cap (if any).
CREATE FUNCTION eventhub.waitlist_has_room(p_event eventhub.event)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT coalesce((p_event.settings->'registration'->>'waitlist')::boolean, false)
       AND ((p_event.settings->'registration'->>'waitlistLimit') IS NULL
            OR (SELECT count(*) FROM eventhub.registration r
                 WHERE r.event_id = p_event.id AND r.status = 'waitlisted'
                   AND r.waitlist_closed_at IS NULL)
               < (p_event.settings->'registration'->>'waitlistLimit')::bigint)
  $$;
REVOKE ALL ON FUNCTION eventhub.waitlist_has_room(eventhub.event) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.waitlist_has_room(eventhub.event) TO eventhub_app;

-- As in 0021, with the cap: 'waitlist' only while the waitlist has room, otherwise 'full'.
CREATE OR REPLACE FUNCTION eventhub.public_registration_state(p_handle text, p_event_slug text)
  RETURNS TABLE (out_state text, out_opens_at timestamptz, out_closes_at timestamptz,
                 out_privacy_policy_url text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT CASE
             WHEN s.state = 'full' AND eventhub.waitlist_has_room(e) THEN 'waitlist'
             ELSE s.state
           END,
           (e.settings->'registration'->>'opensAt')::timestamptz,
           coalesce((e.settings->'registration'->>'closesAt')::timestamptz, e.ends_at),
           e.settings->'legal'->>'privacyPolicyUrl'
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
      CROSS JOIN LATERAL (
        SELECT eventhub.registration_state(
                 e,
                 (SELECT count(*) FROM eventhub.registration r
                   WHERE r.event_id = e.id AND r.status = 'confirmed'),
                 now()) AS state
      ) s
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
  $$;

-- As in 0021, with the cap: a full event adds the visitor to the waitlist only while it has room.
CREATE OR REPLACE FUNCTION eventhub.public_register(p_handle text, p_event_slug text, p_email text,
                                                    p_name text)
  RETURNS TABLE (out_outcome text, out_registration_id uuid, out_organization_id uuid,
                 out_event_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_event eventhub.event;
    v_existing uuid;
    v_confirmed bigint;
    v_state text;
    v_status text := 'confirmed';
    v_privacy text;
    v_id uuid;
  BEGIN
    SELECT e.* INTO v_event
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
       FOR UPDATE OF e;
    IF v_event.id IS NULL THEN
      RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::uuid;
      RETURN;
    END IF;
    SELECT id INTO v_existing FROM eventhub.registration
     WHERE event_id = v_event.id AND email = p_email AND status IN ('confirmed', 'waitlisted');
    IF v_existing IS NOT NULL THEN
      UPDATE eventhub.registration SET repeat_notice_at = now()
       WHERE id = v_existing
         AND (repeat_notice_at IS NULL OR repeat_notice_at < now() - interval '10 minutes');
      RETURN QUERY SELECT CASE WHEN FOUND THEN 'already_registered' ELSE 'already_registered_quiet' END,
                          v_existing, v_event.organization_id, v_event.id;
      RETURN;
    END IF;
    SELECT count(*) INTO v_confirmed FROM eventhub.registration
     WHERE event_id = v_event.id AND status = 'confirmed';
    v_state := eventhub.registration_state(v_event, v_confirmed, now());
    IF v_state = 'full' AND eventhub.waitlist_has_room(v_event) THEN
      v_status := 'waitlisted';
    ELSIF v_state <> 'open' THEN
      RETURN QUERY SELECT v_state, NULL::uuid, v_event.organization_id, v_event.id;
      RETURN;
    END IF;
    v_privacy := v_event.settings->'legal'->>'privacyPolicyUrl';
    IF v_privacy IS NULL THEN
      RETURN QUERY SELECT 'closed'::text, NULL::uuid, v_event.organization_id, v_event.id;
      RETURN;
    END IF;
    INSERT INTO eventhub.registration (organization_id, event_id, email, name, privacy_policy_url,
                                       status)
    VALUES (v_event.organization_id, v_event.id, p_email, p_name, v_privacy, v_status)
    RETURNING id INTO v_id;
    RETURN QUERY SELECT CASE v_status WHEN 'waitlisted' THEN 'waitlisted' ELSE 'registered' END,
                        v_id, v_event.organization_id, v_event.id;
  END $$;

-- As in 0021, but only from the open waitlist: people told it closed are not promoted.
CREATE OR REPLACE FUNCTION eventhub.fill_waitlist(p_organization_id uuid, p_event_id uuid)
  RETURNS TABLE (out_registration_id uuid)
  LANGUAGE plpgsql
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_event eventhub.event;
    v_confirmed bigint;
    v_capacity bigint;
  BEGIN
    SELECT * INTO v_event FROM eventhub.event
     WHERE organization_id = p_organization_id AND id = p_event_id
       FOR UPDATE;
    IF v_event.id IS NULL THEN
      RETURN;
    END IF;
    SELECT count(*) INTO v_confirmed FROM eventhub.registration
     WHERE organization_id = p_organization_id AND event_id = p_event_id AND status = 'confirmed';
    IF eventhub.registration_state(v_event, v_confirmed, now()) NOT IN ('open', 'full') THEN
      RETURN;
    END IF;
    v_capacity := (v_event.settings->'registration'->>'capacity')::bigint;
    RETURN QUERY
      WITH next AS (
        SELECT r.id FROM eventhub.registration r
         WHERE r.organization_id = p_organization_id AND r.event_id = p_event_id
           AND r.status = 'waitlisted' AND r.waitlist_closed_at IS NULL
         ORDER BY r.created_at, r.id
         LIMIT CASE WHEN v_capacity IS NULL THEN NULL ELSE greatest(v_capacity - v_confirmed, 0) END
           FOR UPDATE OF r
      )
      UPDATE eventhub.registration r
         SET status = 'confirmed', promoted_at = now(), promoted_by = 'waitlist'
        FROM next
       WHERE r.id = next.id
      RETURNING r.id;
  END $$;

-- Worker: people still waiting for events whose registration has closed, oldest first, locked
-- for this pass (others skip them). The worker emails each and then marks them.
CREATE FUNCTION eventhub.waitlist_closing(p_limit integer)
  RETURNS TABLE (out_registration_id uuid, out_organization_id uuid, out_email text,
                 out_name text, out_event_name text, out_org_name text, out_handle text,
                 out_event_slug text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.id, r.organization_id, r.email, r.name, e.name, o.display_name, o.public_handle,
           e.slug
      FROM eventhub.registration r
      JOIN eventhub.event e ON e.id = r.event_id AND e.organization_id = r.organization_id
      JOIN eventhub.organization o ON o.id = r.organization_id
     WHERE r.status = 'waitlisted' AND r.waitlist_closed_at IS NULL
       AND (e.lifecycle IN ('ended', 'archived')
            OR now() >= coalesce((e.settings->'registration'->>'closesAt')::timestamptz, e.ends_at))
     ORDER BY r.created_at, r.id
     LIMIT least(greatest(p_limit, 1), 500)
       FOR UPDATE OF r SKIP LOCKED
  $$;

-- Worker: records that one person was told the waitlist closed.
CREATE FUNCTION eventhub.waitlist_mark_closed(p_registration_id uuid, p_organization_id uuid)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.registration SET waitlist_closed_at = now()
     WHERE id = p_registration_id AND organization_id = p_organization_id
       AND status = 'waitlisted' AND waitlist_closed_at IS NULL
  $$;

REVOKE ALL ON FUNCTION eventhub.waitlist_closing(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.waitlist_mark_closed(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.waitlist_closing(integer) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.waitlist_mark_closed(uuid, uuid) TO eventhub_worker;
