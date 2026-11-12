-- Email notification settings and data download alerts (ADR-0049). Expand-only.
--
-- Each member chooses, per organization, whether they receive optional notices. Security notices
-- (two-step requirement changes, support access, two-step reminders) are not optional and have no
-- row here. Absence of a row means the notice's default (packages/kernel NOTIFICATION_KINDS).

CREATE TABLE eventhub.notification_preference (
  organization_id  uuid NOT NULL REFERENCES eventhub.organization (id),
  user_id          uuid NOT NULL REFERENCES eventhub.app_user (id),
  kind             text NOT NULL CHECK (kind IN ('data_download')),
  enabled          boolean NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, kind),
  -- Only members have settings in an organization.
  FOREIGN KEY (organization_id, user_id) REFERENCES eventhub.membership (organization_id, user_id)
);
CREATE TRIGGER notification_preference_tenant_immutable
  BEFORE UPDATE ON eventhub.notification_preference
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

-- A person reads and changes only their own settings, in the organization of the request.
ALTER TABLE eventhub.notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.notification_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preference_own ON eventhub.notification_preference
  FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id()
         AND user_id = eventhub.current_user_id())
  WITH CHECK (organization_id = eventhub.current_organization_id()
              AND user_id = eventhub.current_user_id());
GRANT SELECT, INSERT, UPDATE ON eventhub.notification_preference TO eventhub_app;

-- Worker: who receives an optional notice. Active, verified Owners and Admins (the roles that
-- read the audit log) who have not turned it off, except the person who caused it: they know.
-- Unknown kinds return nobody.
CREATE FUNCTION eventhub.organization_notice_recipients(
  p_organization_id uuid, p_kind text, p_exclude_user_id uuid
)
  RETURNS TABLE (out_user_id uuid, out_email text, out_display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT u.id, u.email, o.display_name
      FROM eventhub.organization o
      JOIN eventhub.membership m ON m.organization_id = o.id
      JOIN eventhub.app_user u ON u.id = m.user_id
      LEFT JOIN eventhub.notification_preference np
        ON np.organization_id = m.organization_id AND np.user_id = m.user_id
       AND np.kind = p_kind
     WHERE o.id = p_organization_id
       AND p_kind = 'data_download'
       AND m.role IN ('owner', 'admin')
       AND m.status = 'active'
       AND u.email_verified_at IS NOT NULL
       AND coalesce(np.enabled, true)
       AND u.id IS DISTINCT FROM p_exclude_user_id
     ORDER BY u.id
  $$;

REVOKE ALL ON FUNCTION eventhub.organization_notice_recipients(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.organization_notice_recipients(uuid, text, uuid)
  TO eventhub_worker;
