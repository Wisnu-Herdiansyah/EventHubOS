-- Attendee self-service (ADR-0065). Expand-only.
--
-- With the personal link from their email (the same token that cancels, ADR-0023), a person can
-- correct their own name and their answers to the registration questions. Their email address
-- is not changed this way: it is who they are to the organizer, and moving it would skip the
-- one-registration-per-address rule. Organizers see when details were last changed.

ALTER TABLE eventhub.registration
  ADD COLUMN details_updated_at timestamptz;

-- Public: what the "change your details" page shows for a link. Nothing for an unknown link,
-- an entry that is no longer active (cancelled or declined), or an event that is not open to
-- changes (not published or live, cancelled, or already ended).
CREATE FUNCTION eventhub.public_registration_details(p_token_hash bytea)
  RETURNS TABLE (out_event_name text, out_org_name text, out_status text, out_name text,
                 out_answers jsonb, out_questions jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT e.name, o.display_name, r.status, r.name, r.answers,
           coalesce(e.settings->'registration'->'questions', '[]'::jsonb)
      FROM eventhub.registration r
      JOIN eventhub.event e ON e.id = r.event_id AND e.organization_id = r.organization_id
      JOIN eventhub.organization o ON o.id = r.organization_id
     WHERE r.cancel_token_hash = p_token_hash
       AND r.status IN ('confirmed', 'waitlisted', 'pending')
       AND e.lifecycle IN ('published', 'live')
       AND e.cancelled_at IS NULL
       AND now() < e.ends_at
  $$;

-- Public: replaces the name and answers of the entry behind a link, under the same conditions.
-- The caller has checked the answers against the event's questions. Returns the entry, and
-- whether anything changed; nothing when the link is not valid.
CREATE FUNCTION eventhub.public_update_registration(p_token_hash bytea, p_name text,
                                                    p_answers jsonb)
  RETURNS TABLE (out_registration_id uuid, out_organization_id uuid, out_event_id uuid,
                 out_event_name text, out_name_changed boolean, out_answers_changed boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_id uuid;
    v_org uuid;
    v_event uuid;
    v_event_name text;
    v_name text;
    v_answers jsonb;
  BEGIN
    SELECT r.id, r.organization_id, r.event_id, e.name, r.name, r.answers
      INTO v_id, v_org, v_event, v_event_name, v_name, v_answers
      FROM eventhub.registration r
      JOIN eventhub.event e ON e.id = r.event_id AND e.organization_id = r.organization_id
     WHERE r.cancel_token_hash = p_token_hash
       AND r.status IN ('confirmed', 'waitlisted', 'pending')
       AND e.lifecycle IN ('published', 'live')
       AND e.cancelled_at IS NULL
       AND now() < e.ends_at
       FOR UPDATE OF r;
    IF v_id IS NULL THEN
      RETURN;
    END IF;
    IF v_name IS DISTINCT FROM p_name OR v_answers IS DISTINCT FROM p_answers THEN
      UPDATE eventhub.registration
         SET name = p_name, answers = p_answers, details_updated_at = now()
       WHERE id = v_id AND organization_id = v_org;
    END IF;
    RETURN QUERY SELECT v_id, v_org, v_event, v_event_name,
                        v_name IS DISTINCT FROM p_name, v_answers IS DISTINCT FROM p_answers;
  END $$;

REVOKE ALL ON FUNCTION eventhub.public_registration_details(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_update_registration(bytea, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_registration_details(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.public_update_registration(bytea, text, jsonb) TO eventhub_app;
