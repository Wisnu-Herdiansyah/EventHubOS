-- Event announcements (ADR-0037). Expand-only.
--
-- An organizer writes one plain-text message to the people registered for an event (and
-- optionally its waitlist). The recipients are captured when it is sent, one row each, so the
-- worker knows exactly whom to email and the organizer can see how many it reached. Someone who
-- cancels before the email goes out is skipped, not emailed. Content is organizer-written text;
-- attendee details stay in `registration` and never enter audit or outbox records.

CREATE TABLE eventhub.announcement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES eventhub.organization (id),
  event_id         uuid NOT NULL,
  -- One line: a subject with a line break could inject email headers.
  subject          text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150
                                        AND subject !~ '[[:cntrl:]]'),
  body             text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  audience         text NOT NULL CHECK (audience IN ('registered', 'registered_and_waitlist')),
  created_by       uuid NOT NULL REFERENCES eventhub.app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, event_id) REFERENCES eventhub.event (organization_id, id),
  UNIQUE (organization_id, id)
);
CREATE INDEX announcement_org_event_created_idx
  ON eventhub.announcement (organization_id, event_id, created_at DESC, id DESC);
CREATE TRIGGER announcement_tenant_immutable BEFORE UPDATE ON eventhub.announcement
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.announcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.announcement FORCE ROW LEVEL SECURITY;
CREATE POLICY announcement_tenant ON eventhub.announcement FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.announcement TO eventhub_app;

-- Who an announcement goes to, captured when it was sent. delivered_at: the email was handed to
-- the provider; skipped_at: no longer registered when the worker got to it.
CREATE TABLE eventhub.announcement_recipient (
  organization_id  uuid NOT NULL,
  announcement_id  uuid NOT NULL,
  registration_id  uuid NOT NULL,
  delivered_at     timestamptz,
  skipped_at       timestamptz,
  PRIMARY KEY (announcement_id, registration_id),
  FOREIGN KEY (organization_id, announcement_id)
    REFERENCES eventhub.announcement (organization_id, id),
  FOREIGN KEY (organization_id, registration_id)
    REFERENCES eventhub.registration (organization_id, id),
  CHECK (delivered_at IS NULL OR skipped_at IS NULL)
);
CREATE TRIGGER announcement_recipient_tenant_immutable BEFORE UPDATE ON eventhub.announcement_recipient
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.announcement_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.announcement_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY announcement_recipient_tenant ON eventhub.announcement_recipient FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.announcement_recipient TO eventhub_app;

-- Worker: the recipients still to be emailed, with what the email needs. `out_active` is false
-- for someone no longer registered (or waiting, when the audience includes the waitlist); the
-- worker marks those skipped instead of emailing them.
CREATE FUNCTION eventhub.announcement_pending(p_announcement_id uuid, p_organization_id uuid)
  RETURNS TABLE (out_registration_id uuid, out_email text, out_name text, out_active boolean,
                 out_subject text, out_body text, out_event_name text, out_org_name text,
                 out_handle text, out_event_slug text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.id, r.email, r.name,
           r.status = 'confirmed'
             OR (r.status = 'waitlisted' AND a.audience = 'registered_and_waitlist'),
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

-- Worker: records that one recipient was emailed (or skipped).
CREATE FUNCTION eventhub.announcement_mark(p_announcement_id uuid, p_organization_id uuid,
                                           p_registration_id uuid, p_delivered boolean)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.announcement_recipient
       SET delivered_at = CASE WHEN p_delivered THEN now() END,
           skipped_at = CASE WHEN p_delivered THEN NULL ELSE now() END
     WHERE announcement_id = p_announcement_id AND organization_id = p_organization_id
       AND registration_id = p_registration_id
       AND delivered_at IS NULL AND skipped_at IS NULL
  $$;

REVOKE ALL ON FUNCTION eventhub.announcement_pending(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.announcement_mark(uuid, uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.announcement_pending(uuid, uuid) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.announcement_mark(uuid, uuid, uuid, boolean) TO eventhub_worker;
