-- Registration questions (ADR-0041). Expand-only.
--
-- Organizers add up to 10 typed questions to the sign-up form (event settings,
-- `registration.questions`). Answers are personal data like the name and email: they live on
-- the registration, under the same RLS, and never enter audit or outbox records. The API
-- validates them against the event's questions before they reach the database; the database
-- bounds their shape and size.

ALTER TABLE eventhub.registration
  ADD COLUMN answers jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(answers) = 'object' AND pg_column_size(answers) <= 32768);

-- Public: the questions of a public event's sign-up form (labels, types, options), with the same
-- visibility rules as its page. An empty array when it has none.
CREATE FUNCTION eventhub.public_registration_questions(p_handle text, p_event_slug text)
  RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT coalesce(e.settings->'registration'->'questions', '[]'::jsonb)
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
  $$;

-- Public sign-up with answers: as public_register (0023), plus the answers. The older function
-- stays for code that does not send answers.
CREATE FUNCTION eventhub.public_register_with_answers(p_handle text, p_event_slug text,
                                                     p_email text, p_name text, p_answers jsonb)
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
                                       status, answers)
    VALUES (v_event.organization_id, v_event.id, p_email, p_name, v_privacy, v_status,
            coalesce(p_answers, '{}'::jsonb))
    RETURNING id INTO v_id;
    RETURN QUERY SELECT CASE v_status WHEN 'waitlisted' THEN 'waitlisted' ELSE 'registered' END,
                        v_id, v_event.organization_id, v_event.id;
  END $$;


REVOKE ALL ON FUNCTION eventhub.public_registration_questions(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_register_with_answers(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_registration_questions(text, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.public_register_with_answers(text, text, text, text, jsonb) TO eventhub_app;
