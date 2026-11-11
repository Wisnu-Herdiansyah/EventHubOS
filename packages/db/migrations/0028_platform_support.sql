-- Platform staff and support access (ADR-0045). Expand-only.
--
-- Platform staff are EventHub people who support organizations. Nobody becomes staff through the
-- API or the web app: only an operator with migrator credentials can add or remove them
-- (`pnpm platform:staff`), so a compromised account cannot promote itself.
--
-- Staff see no tenant data by default. An organization's Owner or Admin grants support access for
-- up to 72 hours; while it lasts, staff who use two-step verification can read that organization
-- (the read-only 'support' role: no attendee data, no changes). Every read is audited in the
-- organization's own log, and the grant can be revoked at any time.

CREATE TABLE eventhub.platform_staff (
  user_id     uuid PRIMARY KEY REFERENCES eventhub.app_user (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
ALTER TABLE eventhub.platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.platform_staff FORCE ROW LEVEL SECURITY;
-- No policies or grants: the runtime roles reach it only through the functions below.

CREATE TABLE eventhub.support_grant (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES eventhub.organization (id),
  granted_by       uuid NOT NULL REFERENCES eventhub.app_user (id),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES eventhub.app_user (id),
  UNIQUE (organization_id, id),
  CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '72 hours'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX support_grant_org_time_idx
  ON eventhub.support_grant (organization_id, granted_at DESC);
CREATE TRIGGER support_grant_tenant_immutable BEFORE UPDATE ON eventhub.support_grant
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.support_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.support_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY support_grant_tenant ON eventhub.support_grant FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.support_grant TO eventhub_app;
GRANT UPDATE (revoked_at, revoked_by) ON eventhub.support_grant TO eventhub_app;

-- Whether a user is platform staff now (not revoked).
CREATE FUNCTION eventhub.is_platform_staff(p_user_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM eventhub.platform_staff
                    WHERE user_id = p_user_id AND revoked_at IS NULL)
  $$;

-- When a staff member's support access to an organization ends, or NULL when they have none:
-- they must be staff, use two-step verification, and the organization must be active with an
-- unrevoked, unexpired grant.
CREATE FUNCTION eventhub.support_access_until(p_organization_id uuid, p_user_id uuid)
  RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT max(g.expires_at)
      FROM eventhub.support_grant g
      JOIN eventhub.organization o ON o.id = g.organization_id AND o.status = 'active'
     WHERE g.organization_id = p_organization_id
       AND g.revoked_at IS NULL AND g.expires_at > now()
       AND eventhub.is_platform_staff(p_user_id)
       AND eventhub.auth_mfa_required(p_user_id)
  $$;

-- Staff overview of organizations: names and counts only, never members' or attendees' details.
-- Raises for anyone who is not staff with two-step verification.
CREATE FUNCTION eventhub.platform_organizations(p_user_id uuid)
  RETURNS TABLE (out_id uuid, out_display_name text, out_public_handle text, out_status text,
                 out_created_at timestamptz, out_members integer, out_events integer,
                 out_support_until timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    IF NOT (eventhub.is_platform_staff(p_user_id) AND eventhub.auth_mfa_required(p_user_id)) THEN
      RAISE EXCEPTION 'not platform staff' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
      SELECT o.id, o.display_name, o.public_handle, o.status, o.created_at,
             (SELECT count(*)::int FROM eventhub.membership m
               WHERE m.organization_id = o.id AND m.status = 'active'),
             (SELECT count(*)::int FROM eventhub.event e WHERE e.organization_id = o.id),
             (SELECT max(g.expires_at) FROM eventhub.support_grant g
               WHERE g.organization_id = o.id AND g.revoked_at IS NULL AND g.expires_at > now())
        FROM eventhub.organization o
       ORDER BY o.created_at DESC, o.id
       LIMIT 500;
  END $$;

-- Staff: the suppression state of one address (ADR-0043), to answer "why don't I get emails?".
CREATE FUNCTION eventhub.platform_email_suppression(p_user_id uuid, p_address text)
  RETURNS TABLE (out_reason text, out_last_event_at timestamptz, out_lifted_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    IF NOT (eventhub.is_platform_staff(p_user_id) AND eventhub.auth_mfa_required(p_user_id)) THEN
      RAISE EXCEPTION 'not platform staff' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
      SELECT s.reason, s.last_event_at, s.lifted_at FROM eventhub.email_suppression s
       WHERE s.address = lower(p_address);
  END $$;

-- Staff: lifts a bounce suppression by hand (for example after the person fixed their mailbox).
-- Complaints are never lifted by staff: the person asked not to be emailed. Audited at platform
-- level with a hash of the address, never the address itself. Returns whether it lifted one.
CREATE FUNCTION eventhub.platform_lift_bounce(p_user_id uuid, p_address text, p_correlation_id text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    IF NOT (eventhub.is_platform_staff(p_user_id) AND eventhub.auth_mfa_required(p_user_id)) THEN
      RAISE EXCEPTION 'not platform staff' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE eventhub.email_suppression SET lifted_at = now()
     WHERE address = lower(p_address) AND reason = 'bounce' AND lifted_at IS NULL;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    INSERT INTO eventhub.audit_event
      (organization_id, actor_type, actor_id, action, target_type, target_id, correlation_id,
       metadata)
    VALUES (NULL, 'platform_support', p_user_id, 'platform.email_bounce_lifted', 'email_address',
            NULL, p_correlation_id,
            jsonb_build_object('addressSha256', encode(sha256(convert_to(lower(p_address), 'UTF8')), 'hex')));
    RETURN true;
  END $$;

REVOKE ALL ON FUNCTION eventhub.is_platform_staff(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.support_access_until(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.platform_organizations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.platform_email_suppression(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.platform_lift_bounce(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.is_platform_staff(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.support_access_until(uuid, uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.platform_organizations(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.platform_email_suppression(uuid, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.platform_lift_bounce(uuid, text, text) TO eventhub_app;
