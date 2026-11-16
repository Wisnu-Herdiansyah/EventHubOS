-- Event reminder emails (ADR-0062). Expand-only.
--
-- Everyone with a confirmed seat gets one reminder in the 24 hours before the event starts.
-- The worker asks for a batch of people who are due, emails each one and marks them, as the
-- waitlist-closing sweep does (0023). Organizers can switch reminders off per event with
-- settings.registration.reminder = false; unset means on.

ALTER TABLE eventhub.registration
  ADD COLUMN reminded_at timestamptz;

-- The sweep looks only at confirmed seats not yet reminded.
CREATE INDEX registration_reminder_due_idx
  ON eventhub.registration (organization_id, event_id)
  WHERE status = 'confirmed' AND reminded_at IS NULL;

-- Worker: confirmed registrations whose reminder is due. Locked rows are skipped, so two
-- workers never remind the same person.
--
-- Due means: the event is published or live, not cancelled, starts within the next 24 hours and
-- has not started; reminders are not switched off; and the person registered before the
-- 24-hour window opened (someone who signs up inside it has just had a confirmation).
CREATE FUNCTION eventhub.event_reminders_due(p_limit integer)
  RETURNS TABLE (out_registration_id uuid, out_organization_id uuid, out_email text,
                 out_name text, out_event_name text, out_org_name text, out_handle text,
                 out_event_slug text, out_starts_at timestamptz, out_timezone text)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT r.id, r.organization_id, r.email, r.name, e.name, o.display_name, o.public_handle,
           e.slug, e.starts_at, e.timezone
      FROM eventhub.registration r
      JOIN eventhub.event e ON e.id = r.event_id AND e.organization_id = r.organization_id
      JOIN eventhub.organization o ON o.id = r.organization_id
     WHERE r.status = 'confirmed' AND r.reminded_at IS NULL
       AND e.lifecycle IN ('published', 'live')
       AND e.cancelled_at IS NULL
       AND e.starts_at > now()
       AND e.starts_at <= now() + interval '24 hours'
       AND r.created_at < e.starts_at - interval '24 hours'
       AND coalesce(e.settings->'registration'->>'reminder', 'true') <> 'false'
     ORDER BY e.starts_at, r.created_at, r.id
     LIMIT least(greatest(p_limit, 1), 500)
       FOR UPDATE OF r SKIP LOCKED
  $$;

-- Worker: records that one person was reminded. The organization must match the registration.
CREATE FUNCTION eventhub.event_reminder_mark(p_registration_id uuid, p_organization_id uuid)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.registration SET reminded_at = now()
     WHERE id = p_registration_id AND organization_id = p_organization_id
       AND status = 'confirmed' AND reminded_at IS NULL
  $$;

REVOKE ALL ON FUNCTION eventhub.event_reminders_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.event_reminder_mark(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.event_reminders_due(integer) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.event_reminder_mark(uuid, uuid) TO eventhub_worker;
