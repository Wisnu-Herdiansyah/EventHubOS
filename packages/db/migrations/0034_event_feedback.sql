-- Post-event feedback (ADR-0063). Expand-only.
--
-- When an organizer switches it on (settings.feedback.enabled), people who attended get one
-- email after the event ends, with a personal link to a short form: a rating from 1 to 5 and an
-- optional comment. Organizers see the answers without names.

ALTER TABLE eventhub.registration
  ADD COLUMN feedback_requested_at timestamptz,
  -- SHA-256 of the personal link's token; the token itself is never stored.
  ADD COLUMN feedback_token_hash   bytea UNIQUE
    CHECK (feedback_token_hash IS NULL OR octet_length(feedback_token_hash) = 32),
  ADD CONSTRAINT registration_feedback_request_pair
    CHECK ((feedback_requested_at IS NULL) = (feedback_token_hash IS NULL));

-- The sweep looks only at confirmed seats not yet asked.
CREATE INDEX registration_feedback_due_idx
  ON eventhub.registration (organization_id, event_id)
  WHERE status = 'confirmed' AND feedback_requested_at IS NULL;

-- One answer per registration. The link to the registration enforces "one each" and lets an
-- answer be changed; it is never shown to organizers.
CREATE TABLE eventhub.event_feedback (
  organization_id  uuid NOT NULL REFERENCES eventhub.organization (id),
  event_id         uuid NOT NULL,
  registration_id  uuid NOT NULL,
  rating           smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment          text CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, registration_id),
  FOREIGN KEY (organization_id, event_id) REFERENCES eventhub.event (organization_id, id),
  FOREIGN KEY (organization_id, registration_id)
    REFERENCES eventhub.registration (organization_id, id)
);
CREATE INDEX event_feedback_org_event_idx
  ON eventhub.event_feedback (organization_id, event_id, updated_at DESC);
CREATE TRIGGER event_feedback_tenant_immutable BEFORE UPDATE ON eventhub.event_feedback
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.event_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.event_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY event_feedback_tenant ON eventhub.event_feedback FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
-- Staff read answers under tenant RLS. Writing happens only through public_feedback_submit.
GRANT SELECT ON eventhub.event_feedback TO eventhub_app;

-- Worker: confirmed registrations to ask for feedback. Locked rows are skipped, so two workers
-- never ask the same person.
--
-- Due means: feedback is switched on; the event has ended, within the last 7 days; it was
-- public and was not cancelled; and the person attended. "Attended" is "checked in" when the
-- event used check-in at all, and "had a confirmed seat" when nobody was checked in.
CREATE FUNCTION eventhub.event_feedback_due(p_limit integer)
  RETURNS TABLE (out_registration_id uuid, out_organization_id uuid, out_email text,
                 out_name text, out_event_name text, out_org_name text, out_handle text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.id, r.organization_id, r.email, r.name, e.name, o.display_name, o.public_handle
      FROM eventhub.registration r
      JOIN eventhub.event e ON e.id = r.event_id AND e.organization_id = r.organization_id
      JOIN eventhub.organization o ON o.id = r.organization_id
     WHERE r.status = 'confirmed' AND r.feedback_requested_at IS NULL
       AND e.settings->'feedback'->>'enabled' = 'true'
       AND e.lifecycle IN ('published', 'live', 'ended')
       AND e.cancelled_at IS NULL
       AND e.ends_at <= now()
       AND e.ends_at > now() - interval '7 days'
       AND o.public_handle IS NOT NULL
       AND (r.checked_in_at IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM eventhub.registration x
                            WHERE x.organization_id = e.organization_id AND x.event_id = e.id
                              AND x.checked_in_at IS NOT NULL))
     ORDER BY e.ends_at, r.created_at, r.id
     LIMIT least(greatest(p_limit, 1), 500)
       FOR UPDATE OF r SKIP LOCKED
  $$;

-- Worker: records that one person was asked, and the hash of their link's token. The
-- organization must match the registration.
CREATE FUNCTION eventhub.event_feedback_mark(p_registration_id uuid, p_organization_id uuid,
                                             p_token_hash bytea)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.registration
       SET feedback_requested_at = now(), feedback_token_hash = p_token_hash
     WHERE id = p_registration_id AND organization_id = p_organization_id
       AND status = 'confirmed' AND feedback_requested_at IS NULL
  $$;

-- Public: what the feedback page shows for a link. Nothing for an unknown link, a cancelled
-- registration, or more than 30 days after the event ended.
CREATE FUNCTION eventhub.public_feedback_lookup(p_token_hash bytea)
  RETURNS TABLE (out_event_name text, out_org_name text, out_answered boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT e.name, o.display_name,
           EXISTS (SELECT 1 FROM eventhub.event_feedback f
                    WHERE f.organization_id = r.organization_id AND f.registration_id = r.id)
      FROM eventhub.registration r
      JOIN eventhub.event e ON e.id = r.event_id AND e.organization_id = r.organization_id
      JOIN eventhub.organization o ON o.id = r.organization_id
     WHERE r.feedback_token_hash = p_token_hash
       AND r.status = 'confirmed'
       AND e.cancelled_at IS NULL
       AND now() < e.ends_at + interval '30 days'
  $$;

-- Public: stores one person's answer, replacing their earlier one. Same conditions as the
-- lookup. Returns the event name, or nothing when the link is not valid.
CREATE FUNCTION eventhub.public_feedback_submit(p_token_hash bytea, p_rating integer,
                                                p_comment text)
  RETURNS TABLE (out_event_name text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH who AS (
      SELECT r.organization_id, r.event_id, r.id, e.name
        FROM eventhub.registration r
        JOIN eventhub.event e ON e.id = r.event_id AND e.organization_id = r.organization_id
       WHERE r.feedback_token_hash = p_token_hash
         AND r.status = 'confirmed'
         AND e.cancelled_at IS NULL
         AND now() < e.ends_at + interval '30 days'
         FOR UPDATE OF r
    ), saved AS (
      INSERT INTO eventhub.event_feedback (organization_id, event_id, registration_id, rating, comment)
      SELECT organization_id, event_id, id, p_rating, nullif(btrim(p_comment), '') FROM who
      ON CONFLICT (organization_id, registration_id)
        DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
      RETURNING 1
    )
    SELECT who.name FROM who, saved
  $$;

REVOKE ALL ON FUNCTION eventhub.event_feedback_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.event_feedback_mark(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_feedback_lookup(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.public_feedback_submit(bytea, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.event_feedback_due(integer) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.event_feedback_mark(uuid, uuid, bytea) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.public_feedback_lookup(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.public_feedback_submit(bytea, integer, text) TO eventhub_app;
