-- Waitlist (ADR-0035). Expand-only.
--
-- When an event with a capacity is full and its `registration.waitlist` setting is on, a public
-- sign-up joins the waitlist instead of being refused. Freed seats go to the waitlist in the
-- order people joined, automatically, under the same lock on the event row that sign-ups take,
-- so seats are never over-filled by a race. Organizers can also promote someone by hand.
--
-- Old application code writes only 'confirmed' and 'cancelled', which the widened check still
-- accepts. Functions whose results change shape get new names; the old ones stay until a later
-- contract migration.

-- 'waitlisted' joins the allowed states (the old check is replaced by a wider one).
ALTER TABLE eventhub.registration
  ADD CONSTRAINT registration_status_values
    CHECK (status IN ('confirmed', 'cancelled', 'waitlisted'));
ALTER TABLE eventhub.registration DROP CONSTRAINT registration_status_check;

-- How a waitlisted person got their seat, and when.
ALTER TABLE eventhub.registration
  ADD COLUMN promoted_at timestamptz,
  ADD COLUMN promoted_by text CHECK (promoted_by IN ('waitlist', 'organizer')),
  ADD CONSTRAINT registration_promotion_pair CHECK ((promoted_at IS NULL) = (promoted_by IS NULL));

-- One active entry (registered or waiting) per address per event. The older, narrower index
-- stays; it is implied by this one.
CREATE UNIQUE INDEX registration_event_email_live_key
  ON eventhub.registration (event_id, email) WHERE status IN ('confirmed', 'waitlisted');
-- The waitlist, in joining order.
CREATE INDEX registration_event_waitlist_idx
  ON eventhub.registration (organization_id, event_id, created_at, id) WHERE status = 'waitlisted';

GRANT UPDATE (promoted_at, promoted_by) ON eventhub.registration TO eventhub_app;

-- Public view of registration: 'waitlist' instead of 'full' when the event takes a waitlist.
CREATE OR REPLACE FUNCTION eventhub.public_registration_state(p_handle text, p_event_slug text)
  RETURNS TABLE (out_state text, out_opens_at timestamptz, out_closes_at timestamptz,
                 out_privacy_policy_url text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT CASE
             WHEN s.state = 'full'
                  AND coalesce((e.settings->'registration'->>'waitlist')::boolean, false)
               THEN 'waitlist'
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

-- Public sign-up. As in 0014, plus: an address already waiting counts as already registered, and
-- a full event with the waitlist on adds the visitor to it (outcome 'waitlisted').
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
    IF v_state = 'full'
       AND coalesce((v_event.settings->'registration'->>'waitlist')::boolean, false) THEN
      v_status := 'waitlisted';
    ELSIF v_state <> 'open' THEN
      RETURN QUERY SELECT v_state, NULL::uuid, v_event.organization_id, v_event.id;
      RETURN;
    END IF;
    v_privacy := v_event.settings->'legal'->>'privacyPolicyUrl';
    IF v_privacy IS NULL THEN
      -- Publishing requires a privacy policy; without one, consent cannot be recorded.
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

-- Worker: binds a link token to a registered or waiting entry; returns what the email needs,
-- including the current status so the email matches it. Supersedes
-- registration_issue_cancel_token (confirmed only).
CREATE FUNCTION eventhub.registration_issue_link_token(p_registration_id uuid,
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
       AND r.status IN ('confirmed', 'waitlisted')
       AND e.id = r.event_id AND o.id = r.organization_id
    RETURNING r.email, r.name, e.name, e.starts_at, e.timezone, o.public_handle, e.slug, r.status
  $$;

-- Public cancellation with the emailed link: a registration, or a place on the waitlist. Returns
-- the entry, and what it was, when it was cancelled now. Takes the event lock first, like every
-- path that changes seats, so it cannot deadlock with a promotion. Supersedes
-- public_cancel_registration.
CREATE FUNCTION eventhub.public_leave_registration(p_token_hash bytea)
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
       AND r.status IN ('confirmed', 'waitlisted')
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

-- Gives freed seats to the waitlist, oldest first, while registration is still running
-- (published or live, before it closes). Runs as the caller, under tenant RLS, and locks the
-- event row as public_register does, so a sign-up and a promotion cannot both take the last seat.
-- Without a capacity every waiting person gets a seat. Returns the promoted entries.
CREATE FUNCTION eventhub.fill_waitlist(p_organization_id uuid, p_event_id uuid)
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
           AND r.status = 'waitlisted'
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

REVOKE ALL ON FUNCTION eventhub.registration_issue_link_token(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_leave_registration(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.fill_waitlist(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.registration_issue_link_token(uuid, uuid, bytea) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.public_leave_registration(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.fill_waitlist(uuid, uuid) TO eventhub_app;
