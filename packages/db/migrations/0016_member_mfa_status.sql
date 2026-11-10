-- Who in an organization uses two-step verification (ADR-0025). Expand-only.
--
-- auth_mfa_factor has forced RLS and no policies, so the tenant cannot read it directly. This
-- function returns one boolean per member of the organization in the current tenant context and
-- nothing else: no secrets, dates or recovery code counts. The API shows it only to roles with
-- membership.manage.

CREATE FUNCTION eventhub.organization_member_mfa(p_organization_id uuid)
  RETURNS TABLE (out_user_id uuid, out_mfa_enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT m.user_id,
           EXISTS (SELECT 1 FROM eventhub.auth_mfa_factor f
                    WHERE f.user_id = m.user_id AND f.status = 'active')
      FROM eventhub.membership m
     WHERE m.organization_id = p_organization_id
       AND p_organization_id = eventhub.current_organization_id()
  $$;

REVOKE ALL ON FUNCTION eventhub.organization_member_mfa(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.organization_member_mfa(uuid) TO eventhub_app;
