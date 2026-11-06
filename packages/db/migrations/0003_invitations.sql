-- Organization invitations (ORG-02, ADR-0010).
--
-- Tenant-owned with forced RLS like every other tenant table. The token hash is written only by
-- the worker (SECURITY DEFINER) and is not readable by the runtime role (column-level grants).
-- Acceptance resolves the organization from the token on the server, never from client input.

CREATE TABLE eventhub.invitation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES eventhub.organization (id),
  email            text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 320),
  role             text NOT NULL CHECK (role IN ('owner', 'admin', 'billing_admin', 'event_manager',
                                                 'content_editor', 'registration_manager', 'analyst', 'viewer')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by       uuid NOT NULL REFERENCES eventhub.app_user (id),
  token_hash       bytea UNIQUE CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_by      uuid REFERENCES eventhub.app_user (id),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES eventhub.app_user (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  CHECK (expires_at > created_at),
  UNIQUE (organization_id, id)
);
-- At most one live invitation per address per organization.
CREATE UNIQUE INDEX invitation_pending_email_key ON eventhub.invitation (organization_id, email)
  WHERE status = 'pending';
CREATE INDEX invitation_org_created_idx ON eventhub.invitation (organization_id, created_at DESC, id DESC);
CREATE TRIGGER invitation_touch BEFORE UPDATE ON eventhub.invitation
  FOR EACH ROW EXECUTE FUNCTION eventhub.touch_updated_at();
CREATE TRIGGER invitation_tenant_immutable BEFORE UPDATE ON eventhub.invitation
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_tenant ON eventhub.invitation FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
-- Every column except token_hash is readable; only lifecycle columns are updatable.
GRANT SELECT (id, organization_id, email, role, status, invited_by, created_at, expires_at,
              accepted_at, accepted_by, revoked_at, revoked_by, updated_at, version)
  ON eventhub.invitation TO eventhub_app;
GRANT INSERT (organization_id, email, role, invited_by, expires_at) ON eventhub.invitation TO eventhub_app;
GRANT UPDATE (status, accepted_at, accepted_by, revoked_at, revoked_by) ON eventhub.invitation TO eventhub_app;

-- ---------------------------------------------------------------------------------------------
-- Tenant-bound helpers. Each refuses to answer for any organization other than the caller's
-- current tenant context, so they cannot be used to probe other tenants.
-- ---------------------------------------------------------------------------------------------

-- Members with their email addresses (app_user rows are otherwise visible only to their owner).
CREATE FUNCTION eventhub.organization_members(p_organization_id uuid)
  RETURNS TABLE (out_membership_id uuid, out_user_id uuid, out_email text, out_role text,
                 out_status text, out_accepted_at timestamptz, out_created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT m.id, m.user_id, u.email, m.role, m.status, m.accepted_at, m.created_at
      FROM eventhub.membership m
      JOIN eventhub.app_user u ON u.id = m.user_id
     WHERE m.organization_id = p_organization_id
       AND p_organization_id = eventhub.current_organization_id()
     ORDER BY m.created_at, m.id
  $$;

CREATE FUNCTION eventhub.organization_has_member_email(p_organization_id uuid, p_email text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT p_organization_id = eventhub.current_organization_id()
       AND EXISTS (SELECT 1
                     FROM eventhub.membership m
                     JOIN eventhub.app_user u ON u.id = m.user_id
                    WHERE m.organization_id = p_organization_id
                      AND m.status = 'active'
                      AND u.email = p_email)
  $$;

-- Pre-tenant lookup for acceptance: the token alone identifies the invitation and therefore the
-- organization. Returns nothing for unknown, used, revoked, or expired tokens.
CREATE FUNCTION eventhub.invitation_resolve(p_token_hash bytea)
  RETURNS TABLE (out_invitation_id uuid, out_organization_id uuid, out_email text, out_role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT i.id, i.organization_id, i.email, i.role
      FROM eventhub.invitation i
      JOIN eventhub.organization o ON o.id = i.organization_id AND o.status = 'active'
     WHERE i.token_hash = p_token_hash
       AND i.status = 'pending'
       AND i.expires_at > now()
  $$;

-- Worker-only: binds a token hash to a still-pending invitation and returns what the email
-- needs. The organization ID must match (aggregate ownership revalidated by the consumer).
-- Re-issuing replaces the previous hash, so only the newest emailed link works.
CREATE FUNCTION eventhub.invitation_issue_token(p_invitation_id uuid, p_organization_id uuid, p_token_hash bytea)
  RETURNS TABLE (out_email text, out_organization_name text, out_role text, out_expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    RETURN QUERY
      WITH issued AS (
        UPDATE eventhub.invitation i
           SET token_hash = p_token_hash
          FROM eventhub.organization o
         WHERE i.id = p_invitation_id
           AND i.organization_id = p_organization_id
           AND o.id = i.organization_id
           AND o.status = 'active'
           AND i.status = 'pending'
           AND i.expires_at > now()
        RETURNING i.email, o.display_name, i.role, i.expires_at
      )
      SELECT * FROM issued;
  END $$;

REVOKE ALL ON FUNCTION eventhub.organization_members(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.organization_has_member_email(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.invitation_resolve(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.invitation_issue_token(uuid, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.organization_members(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.organization_has_member_email(uuid, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.invitation_resolve(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.invitation_issue_token(uuid, uuid, bytea) TO eventhub_worker;
