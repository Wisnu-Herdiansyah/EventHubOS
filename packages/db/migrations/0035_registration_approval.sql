-- Registration approval (ADR-0064). Expand-only.
--
-- An organizer can require approval for an event (settings.registration.approval). A sign-up
-- then waits as 'pending' until staff approve it (it becomes 'confirmed') or decline it (it
-- becomes 'declined'). A pending request does not hold a seat. The person can withdraw it with
-- the link in their email, as they would cancel a registration.
--
-- Old application code writes 'confirmed', 'cancelled' and 'waitlisted', which the widened check
-- still accepts.

ALTER TABLE eventhub.registration
  ADD CONSTRAINT registration_status_values_v2
    CHECK (status IN ('confirmed', 'cancelled', 'waitlisted', 'pending', 'declined'));
ALTER TABLE eventhub.registration DROP CONSTRAINT registration_status_values;

-- Who approved or declined a request, and when. Set once, by staff.
ALTER TABLE eventhub.registration
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decided_by uuid REFERENCES eventhub.app_user (id),
  ADD CONSTRAINT registration_decision_pair CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  ADD CONSTRAINT registration_declined_decided CHECK (status <> 'declined' OR decided_at IS NOT NULL);
GRANT UPDATE (decided_at, decided_by) ON eventhub.registration TO eventhub_app;

-- Requests waiting for a decision, oldest first, for the organizer's list.
CREATE INDEX registration_pending_idx
  ON eventhub.registration (organization_id, event_id, created_at, id)
  WHERE status = 'pending';

-- Public sign-up with answers: as in 0024, plus approval. With approval on, an open event takes
-- the sign-up as a pending request; a full one is still refused (requests hold no seat, and an
-- event cannot take both approval and a waitlist). Someone already pending is "already
-- registered"; someone declined gets the same quiet answer and no new request.
CREATE OR REPLACE FUNCTION eventhub.public_register_with_answers(p_handle text, p_event_slug text,
                                                                p_email text, p_name text,
                                                                p_answers jsonb)
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
     WHERE event_id = v_event.id AND email = p_email
       AND status IN ('confirmed', 'waitlisted', 'pending');
    IF v_existing IS NOT NULL THEN
      UPDATE eventhub.registration SET repeat_notice_at = now()
       WHERE id = v_existing
         AND (repeat_notice_at IS NULL OR repeat_notice_at < now() - interval '10 minutes');
      RETURN QUERY SELECT CASE WHEN FOUND THEN 'already_registered' ELSE 'already_registered_quiet' END,
                          v_existing, v_event.organization_id, v_event.id;
      RETURN;
    END IF;
    -- A declined request is final for this address: no new request and no email.
    IF EXISTS (SELECT 1 FROM eventhub.registration
                WHERE event_id = v_event.id AND email = p_email AND status = 'declined') THEN
      RETURN QUERY SELECT 'already_registered_quiet'::text, NULL::uuid, v_event.organization_id,
                          v_event.id;
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
    ELSIF coalesce((v_event.settings->'registration'->>'approval')::boolean, false) THEN
      v_status := 'pending';
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
    RETURN QUERY SELECT CASE v_status WHEN 'waitlisted' THEN 'waitlisted'
                                      WHEN 'pending' THEN 'requested'
                                      ELSE 'registered' END,
                        v_id, v_event.organization_id, v_event.id;
  END $$;

-- The older sign-up (0023), kept for code that sends no answers, now follows the same rules.
CREATE OR REPLACE FUNCTION eventhub.public_register(p_handle text, p_event_slug text, p_email text,
                                                    p_name text)
  RETURNS TABLE (out_outcome text, out_registration_id uuid, out_organization_id uuid,
                 out_event_id uuid)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT * FROM eventhub.public_register_with_answers(p_handle, p_event_slug, p_email, p_name,
                                                         '{}'::jsonb)
  $$;

-- As in 0021, plus pending requests: their email carries a link to withdraw the request.
CREATE OR REPLACE FUNCTION eventhub.registration_issue_link_token(p_registration_id uuid,
                                                                  p_organization_id uuid,
                                                                  p_token_hash bytea)
  RETURNS TABLE (out_email text, out_name text, out_event_name text, out_starts_at timestamptz,
                 out_timezone text, out_handle text, out_event_slug text, out_status text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.registration r SET cancel_token_hash = p_token_hash
      FROM eventhub.event e, eventhub.organization o
     WHERE r.id = p_registration_id AND r.organization_id = p_organization_id
       AND r.status IN ('confirmed', 'waitlisted', 'pending')
       AND e.id = r.event_id AND o.id = r.organization_id
    RETURNING r.email, r.name, e.name, e.starts_at, e.timezone, o.public_handle, e.slug, r.status
  $$;

-- As in 0021, plus pending requests, which the person can withdraw with the same link.
CREATE OR REPLACE FUNCTION eventhub.public_leave_registration(p_token_hash bytea)
  RETURNS TABLE (out_registration_id uuid, out_organization_id uuid, out_event_id uuid,
                 out_event_name text, out_previous_status text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_event_id uuid;
    v_event_name text;
    v_previous text;
  BEGIN
    SELECT r.event_id INTO v_event_id FROM eventhub.registration r
     WHERE r.cancel_token_hash = p_token_hash;
    IF v_event_id IS NULL THEN
      RETURN;
    END IF;
    SELECT e.name INTO v_event_name FROM eventhub.event e
     WHERE e.id = v_event_id AND e.lifecycle IN ('published', 'live')
       FOR UPDATE;
    IF v_event_name IS NULL THEN
      RETURN;
    END IF;
    SELECT r.status INTO v_previous FROM eventhub.registration r
     WHERE r.cancel_token_hash = p_token_hash AND r.event_id = v_event_id
       AND r.status IN ('confirmed', 'waitlisted', 'pending')
       FOR UPDATE;
    IF v_previous IS NULL THEN
      RETURN;
    END IF;
    RETURN QUERY
      UPDATE eventhub.registration r
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'attendee'
       WHERE r.cancel_token_hash = p_token_hash AND r.event_id = v_event_id
      RETURNING r.id, r.organization_id, r.event_id, v_event_name, v_previous;
  END $$;

-- As in 0026, plus pending requests for messages that reach the waitlist. Ordinary announcements
-- never capture pending requests; the event cancellation notice does, so that everyone who
-- asked to come hears that the event is cancelled.
CREATE OR REPLACE FUNCTION eventhub.announcement_pending(p_announcement_id uuid, p_organization_id uuid)
  RETURNS TABLE (out_registration_id uuid, out_email text, out_name text, out_active boolean,
                 out_subject text, out_body text, out_event_name text, out_org_name text,
                 out_handle text, out_event_slug text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.id, r.email, r.name,
           (r.status = 'confirmed'
             OR (r.status IN ('waitlisted', 'pending') AND a.audience = 'registered_and_waitlist'))
             AND NOT EXISTS (SELECT 1 FROM eventhub.email_suppression s
                              WHERE s.address = lower(r.email) AND s.lifted_at IS NULL),
           a.subject, a.body, e.name, o.display_name, o.public_handle, e.slug
      FROM eventhub.announcement a
      JOIN eventhub.announcement_recipient ar
        ON ar.announcement_id = a.id AND ar.organization_id = a.organization_id
      JOIN eventhub.registration r
        ON r.id = ar.registration_id AND r.organization_id = a.organization_id
      JOIN eventhub.event e ON e.id = a.event_id AND e.organization_id = a.organization_id
      JOIN eventhub.organization o ON o.id = a.organization_id
     WHERE a.id = p_announcement_id AND a.organization_id = p_organization_id
       AND ar.delivered_at IS NULL AND ar.skipped_at IS NULL
     ORDER BY r.id
  $$;

-- Public: whether sign-ups to a public page's event wait for approval, so the form can say so.
-- Same visibility rules as public_registration_state; a new function, so that one keeps its shape.
CREATE FUNCTION eventhub.public_registration_requires_approval(p_handle text, p_event_slug text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT coalesce((e.settings->'registration'->>'approval')::boolean, false)
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
  $$;
REVOKE ALL ON FUNCTION eventhub.public_registration_requires_approval(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.public_registration_requires_approval(text, text) TO eventhub_app;
