-- Free event registration (ADR-0023). Expand-only.
--
-- Registrations are tenant-owned personal data with forced RLS. Visitors are anonymous, so public
-- sign-up and cancellation go through SECURITY DEFINER functions that apply the same rules as the
-- public page (published/live, public or unlisted, active organization) plus the registration
-- window and capacity, checked under a lock on the event row so concurrent sign-ups cannot exceed
-- capacity. Cancel links carry a token whose SHA-256 hash is stored; the worker mints it.

CREATE TABLE eventhub.registration (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES eventhub.organization (id),
  event_id            uuid NOT NULL,
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 320),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status              text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  -- Consent evidence: when, and which privacy policy the attendee was shown.
  privacy_policy_url  text NOT NULL CHECK (char_length(privacy_policy_url) BETWEEN 8 AND 2048),
  consented_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_at        timestamptz,
  cancelled_by        text CHECK (cancelled_by IN ('attendee', 'organizer')),
  -- Throttles "you are already registered" emails (at most one per 10 minutes per registration).
  repeat_notice_at    timestamptz,
  cancel_token_hash   bytea UNIQUE CHECK (cancel_token_hash IS NULL OR octet_length(cancel_token_hash) = 32),
  FOREIGN KEY (organization_id, event_id) REFERENCES eventhub.event (organization_id, id),
  UNIQUE (organization_id, id),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- One active registration per address per event.
CREATE UNIQUE INDEX registration_event_email_active_key
  ON eventhub.registration (event_id, email) WHERE status = 'confirmed';
CREATE INDEX registration_org_event_created_idx
  ON eventhub.registration (organization_id, event_id, created_at DESC, id DESC);
CREATE TRIGGER registration_tenant_immutable BEFORE UPDATE ON eventhub.registration
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.registration FORCE ROW LEVEL SECURITY;
CREATE POLICY registration_tenant ON eventhub.registration FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
-- Staff read and cancel; creation happens only through public_register().
GRANT SELECT ON eventhub.registration TO eventhub_app;
GRANT UPDATE (status, cancelled_at, cancelled_by) ON eventhub.registration TO eventhub_app;

-- Registration state for a public event at a moment: open, not_open_yet, closed or full.
-- Without an opening time registration is open once published; without a closing time it closes
-- when the event ends.
CREATE FUNCTION eventhub.registration_state(p_event eventhub.event, p_confirmed bigint, p_now timestamptz)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT CASE
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

-- Public view of registration for an event page.
CREATE FUNCTION eventhub.public_registration_state(p_handle text, p_event_slug text)
  RETURNS TABLE (out_state text, out_opens_at timestamptz, out_closes_at timestamptz,
                 out_privacy_policy_url text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT eventhub.registration_state(
             e,
             (SELECT count(*) FROM eventhub.registration r
               WHERE r.event_id = e.id AND r.status = 'confirmed'),
             now()),
           (e.settings->'registration'->>'opensAt')::timestamptz,
           coalesce((e.settings->'registration'->>'closesAt')::timestamptz, e.ends_at),
           e.settings->'legal'->>'privacyPolicyUrl'
      FROM eventhub.organization o
      JOIN eventhub.event e ON e.organization_id = o.id AND e.slug = p_event_slug
     WHERE o.public_handle = p_handle
       AND o.status = 'active'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND coalesce(e.settings->>'visibility', 'public') IN ('public', 'unlisted')
  $$;

-- Public sign-up. Outcomes: registered, already_registered (a notice may be sent),
-- already_registered_quiet (a notice was sent recently), not_open_yet, closed, full, not_found.
CREATE FUNCTION eventhub.public_register(p_handle text, p_event_slug text, p_email text, p_name text)
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
     WHERE event_id = v_event.id AND email = p_email AND status = 'confirmed';
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
    IF v_state <> 'open' THEN
      RETURN QUERY SELECT v_state, NULL::uuid, v_event.organization_id, v_event.id;
      RETURN;
    END IF;
    v_privacy := v_event.settings->'legal'->>'privacyPolicyUrl';
    IF v_privacy IS NULL THEN
      -- Publishing requires a privacy policy; without one, consent cannot be recorded.
      RETURN QUERY SELECT 'closed'::text, NULL::uuid, v_event.organization_id, v_event.id;
      RETURN;
    END IF;
    INSERT INTO eventhub.registration (organization_id, event_id, email, name, privacy_policy_url)
    VALUES (v_event.organization_id, v_event.id, p_email, p_name, v_privacy)
    RETURNING id INTO v_id;
    RETURN QUERY SELECT 'registered'::text, v_id, v_event.organization_id, v_event.id;
  END $$;

-- Worker: binds a cancel-link token to a confirmed registration and returns what the email needs.
CREATE FUNCTION eventhub.registration_issue_cancel_token(p_registration_id uuid, p_organization_id uuid,
                                                         p_token_hash bytea)
  RETURNS TABLE (out_email text, out_name text, out_event_name text, out_starts_at timestamptz,
                 out_timezone text, out_handle text, out_event_slug text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.registration r SET cancel_token_hash = p_token_hash
      FROM eventhub.event e, eventhub.organization o
     WHERE r.id = p_registration_id AND r.organization_id = p_organization_id
       AND r.status = 'confirmed'
       AND e.id = r.event_id AND o.id = r.organization_id
    RETURNING r.email, r.name, e.name, e.starts_at, e.timezone, o.public_handle, e.slug
  $$;

-- Worker: what a notice about an existing registration needs (no token change).
CREATE FUNCTION eventhub.registration_notice_details(p_registration_id uuid, p_organization_id uuid)
  RETURNS TABLE (out_email text, out_name text, out_event_name text, out_starts_at timestamptz,
                 out_timezone text, out_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.email, r.name, e.name, e.starts_at, e.timezone, r.status
      FROM eventhub.registration r
      JOIN eventhub.event e ON e.id = r.event_id
     WHERE r.id = p_registration_id AND r.organization_id = p_organization_id
  $$;

-- Public cancellation with the emailed link. Returns the registration when it was cancelled now.
CREATE FUNCTION eventhub.public_cancel_registration(p_token_hash bytea)
  RETURNS TABLE (out_registration_id uuid, out_organization_id uuid, out_event_id uuid,
                 out_event_name text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.registration r
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'attendee'
      FROM eventhub.event e
     WHERE r.cancel_token_hash = p_token_hash AND r.status = 'confirmed'
       AND e.id = r.event_id AND e.lifecycle IN ('published', 'live')
    RETURNING r.id, r.organization_id, r.event_id, e.name
  $$;

REVOKE ALL ON FUNCTION eventhub.registration_state(eventhub.event, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_registration_state(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_register(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.registration_issue_cancel_token(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.registration_notice_details(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_cancel_registration(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.registration_state(eventhub.event, bigint, timestamptz) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.public_registration_state(text, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.public_register(text, text, text, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.public_cancel_registration(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.registration_issue_cancel_token(uuid, uuid, bytea) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.registration_notice_details(uuid, uuid) TO eventhub_worker;
