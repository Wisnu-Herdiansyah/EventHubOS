-- Announcements to requests waiting for approval (ADR-0068). Expand-only.
--
-- With approval on (ADR-0064), people can wait days for a decision. An organizer can now write
-- to just them ("we will decide by Friday") with a third audience, 'requests'. Only requests
-- still waiting when the email goes out are emailed: someone approved, declined or who withdrew
-- in the meantime is skipped, since the message was about a decision they no longer wait for.
--
-- Old application code writes 'registered' and 'registered_and_waitlist', which the widened
-- check still accepts.

ALTER TABLE eventhub.announcement
  ADD CONSTRAINT announcement_audience_values_v2
    CHECK (audience IN ('registered', 'registered_and_waitlist', 'requests'));
ALTER TABLE eventhub.announcement DROP CONSTRAINT announcement_audience_check;

-- As in 0035, plus the 'requests' audience: active only while the request is still pending.
CREATE OR REPLACE FUNCTION eventhub.announcement_pending(p_announcement_id uuid, p_organization_id uuid)
  RETURNS TABLE (out_registration_id uuid, out_email text, out_name text, out_active boolean,
                 out_subject text, out_body text, out_event_name text, out_org_name text,
                 out_handle text, out_event_slug text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.id, r.email, r.name,
           CASE WHEN a.audience = 'requests' THEN r.status = 'pending'
                ELSE r.status = 'confirmed'
                  OR (r.status IN ('waitlisted', 'pending')
                      AND a.audience = 'registered_and_waitlist')
           END
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
