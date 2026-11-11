-- Reminding members to turn on two-step verification (ADR-0031). Expand-only.
--
-- two_step_reminded_at limits reminders to one per member per day. The worker resolves the
-- recipient through a definer function that returns nothing once the member is gone or has
-- turned two-step verification on, so a late reminder is never sent.

ALTER TABLE eventhub.membership ADD COLUMN two_step_reminded_at timestamptz;
GRANT UPDATE (two_step_reminded_at) ON eventhub.membership TO eventhub_app;

CREATE FUNCTION eventhub.two_step_reminder_details(p_membership_id uuid, p_organization_id uuid)
  RETURNS TABLE (out_email text, out_display_name text, out_role text, out_required boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT u.email, o.display_name, m.role, o.require_mfa_for_admins
      FROM eventhub.membership m
      JOIN eventhub.organization o ON o.id = m.organization_id
      JOIN eventhub.app_user u ON u.id = m.user_id
     WHERE m.id = p_membership_id
       AND m.organization_id = p_organization_id
       AND m.status = 'active'
       AND u.email_verified_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM eventhub.auth_mfa_factor f
                        WHERE f.user_id = m.user_id AND f.status = 'active')
  $$;

REVOKE ALL ON FUNCTION eventhub.two_step_reminder_details(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.two_step_reminder_details(uuid, uuid) TO eventhub_worker;
