-- Email bounces and complaints (ADR-0043). Expand-only.
--
-- The email provider reports, by signed webhook, when an address bounced (the mailbox does not
-- exist or refuses mail), when someone marked our email as spam, and when an email was delivered.
-- Bounced and complaining addresses go on a suppression list that applies across the platform:
-- a dead mailbox is dead for every organization, and complaints count against our sending
-- reputation as a whole. The worker consults the list before every email (by kind of email);
-- organizers see only that an attendee's address cannot receive email, never why.
--
-- Not tenant data: no organization owns an address's deliverability. Both tables are reachable
-- only through the functions below, never directly by the runtime roles.

CREATE TABLE eventhub.email_suppression (
  -- Lowercased.
  address          text PRIMARY KEY CHECK (address = lower(address) AND char_length(address) <= 320),
  -- 'complaint' wins over 'bounce': once someone complained, a later delivery does not lift it.
  reason           text NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  first_event_at   timestamptz NOT NULL,
  last_event_at    timestamptz NOT NULL,
  event_count      integer NOT NULL DEFAULT 1 CHECK (event_count > 0),
  -- A bounce is lifted when a later email to the address was delivered.
  lifted_at        timestamptz,
  CHECK (lifted_at IS NULL OR reason = 'bounce')
);

-- One row per provider event, so a retried webhook delivery changes nothing the second time.
-- No addresses here: the suppression list holds what is needed.
CREATE TABLE eventhub.email_feedback_event (
  provider             text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  event_id             text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  kind                 text NOT NULL CHECK (kind IN ('bounce', 'complaint', 'delivered')),
  provider_message_id  text NOT NULL CHECK (char_length(provider_message_id) BETWEEN 1 AND 200),
  recipient_count      integer NOT NULL CHECK (recipient_count BETWEEN 1 AND 50),
  occurred_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

ALTER TABLE eventhub.email_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.email_suppression FORCE ROW LEVEL SECURITY;
ALTER TABLE eventhub.email_feedback_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.email_feedback_event FORCE ROW LEVEL SECURITY;
-- No policies and no grants: only the definer functions below reach these tables.

-- Records one verified webhook event. Returns false when it was already recorded (a retry).
-- Bounces and complaints suppress their addresses; a delivery lifts an earlier bounce (never a
-- complaint) when it happened after that bounce.
CREATE FUNCTION eventhub.record_email_feedback(p_provider text, p_event_id text, p_kind text,
                                               p_message_id text, p_occurred_at timestamptz,
                                               p_addresses text[])
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_addresses text[];
  BEGIN
    SELECT coalesce(array_agg(DISTINCT lower(a)), '{}') INTO v_addresses
      FROM unnest(p_addresses) a;
    INSERT INTO eventhub.email_feedback_event
      (provider, event_id, kind, provider_message_id, recipient_count, occurred_at)
    VALUES (p_provider, p_event_id, p_kind, p_message_id, cardinality(v_addresses), p_occurred_at)
    ON CONFLICT (provider, event_id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    IF p_kind IN ('bounce', 'complaint') THEN
      INSERT INTO eventhub.email_suppression AS s (address, reason, first_event_at, last_event_at)
      SELECT a, p_kind, p_occurred_at, p_occurred_at FROM unnest(v_addresses) a
      ON CONFLICT (address) DO UPDATE
        SET reason = CASE WHEN s.reason = 'complaint' OR p_kind = 'complaint'
                          THEN 'complaint' ELSE 'bounce' END,
            last_event_at = greatest(s.last_event_at, p_occurred_at),
            event_count = s.event_count + 1,
            lifted_at = NULL;
    ELSE
      UPDATE eventhub.email_suppression
         SET lifted_at = now()
       WHERE address = ANY (v_addresses)
         AND reason = 'bounce' AND lifted_at IS NULL
         AND last_event_at < p_occurred_at;
    END IF;
    RETURN true;
  END $$;

-- For organizers: which of these addresses cannot receive email now. Says nothing about why or
-- since when. The caller passes only addresses from its own tenant's registrations.
CREATE FUNCTION eventhub.email_undeliverable(p_addresses text[])
  RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT s.address FROM eventhub.email_suppression s
     WHERE s.address = ANY (SELECT lower(a) FROM unnest(p_addresses) a)
       AND s.lifted_at IS NULL
  $$;

-- For the worker: why an address is suppressed ('bounce' or 'complaint'), or NULL.
CREATE FUNCTION eventhub.email_suppression_reason(p_address text)
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT s.reason FROM eventhub.email_suppression s
     WHERE s.address = lower(p_address) AND s.lifted_at IS NULL
  $$;

-- Announcements (0022) also skip recipients whose address is suppressed for organizer mail
-- (any active suppression), so the organizer sees them as skipped.
CREATE OR REPLACE FUNCTION eventhub.announcement_pending(p_announcement_id uuid, p_organization_id uuid)
  RETURNS TABLE (out_registration_id uuid, out_email text, out_name text, out_active boolean,
                 out_subject text, out_body text, out_event_name text, out_org_name text,
                 out_handle text, out_event_slug text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.id, r.email, r.name,
           (r.status = 'confirmed'
             OR (r.status = 'waitlisted' AND a.audience = 'registered_and_waitlist'))
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

REVOKE ALL ON FUNCTION eventhub.record_email_feedback(text, text, text, text, timestamptz, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.email_undeliverable(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.email_suppression_reason(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.record_email_feedback(text, text, text, text, timestamptz, text[]) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.email_undeliverable(text[]) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.email_suppression_reason(text) TO eventhub_worker;
