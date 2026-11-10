-- Emailing Owners when an organization's security settings change (ADR-0026). Expand-only.
--
-- The worker has no tenant context. This function gives it exactly what the notice needs for the
-- organization named by an outbox event: the organization's name and its active Owners'
-- addresses. Granted to the worker role only.

CREATE FUNCTION eventhub.organization_security_contacts(p_organization_id uuid)
  RETURNS TABLE (out_user_id uuid, out_email text, out_display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT u.id, u.email, o.display_name
      FROM eventhub.organization o
      JOIN eventhub.membership m ON m.organization_id = o.id
      JOIN eventhub.app_user u ON u.id = m.user_id
     WHERE o.id = p_organization_id
       AND m.role = 'owner'
       AND m.status = 'active'
       AND u.email_verified_at IS NOT NULL
     ORDER BY u.id
  $$;

REVOKE ALL ON FUNCTION eventhub.organization_security_contacts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.organization_security_contacts(uuid) TO eventhub_worker;
