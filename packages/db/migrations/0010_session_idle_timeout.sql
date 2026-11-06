-- Idle session timeout (ADR-0018). Expand-only: two overloads, no schema changes.
--
-- A session ends after p_idle_seconds without activity, on top of its absolute expiry. Activity
-- is recorded at most every 5 minutes (ADR-0017), so the effective timeout is within 5 minutes of
-- the setting. Sessions with no recorded activity yet (created before migration 0009) start their
-- idle clock on their next request, so deploying this does not sign everyone out at once.

CREATE FUNCTION eventhub.auth_resolve_and_touch_session(p_token_hash bytea, p_idle_seconds integer)
  RETURNS TABLE (out_session_id uuid, out_user_id uuid, out_email_verified boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_session_id uuid;
    v_user_id uuid;
    v_verified boolean;
    v_last_seen timestamptz;
  BEGIN
    SELECT s.id, u.id, u.email_verified_at IS NOT NULL, s.last_seen_at
      INTO v_session_id, v_user_id, v_verified, v_last_seen
      FROM eventhub.auth_session s
      JOIN eventhub.app_user u ON u.id = s.user_id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now();
    IF v_session_id IS NULL THEN
      RETURN;
    END IF;
    IF v_last_seen IS NOT NULL AND v_last_seen < now() - make_interval(secs => p_idle_seconds) THEN
      -- Idle too long: end it now, so it can never be revived.
      UPDATE eventhub.auth_session SET revoked_at = now()
       WHERE id = v_session_id AND revoked_at IS NULL;
      RETURN;
    END IF;
    IF v_last_seen IS NULL OR v_last_seen < now() - interval '5 minutes' THEN
      UPDATE eventhub.auth_session SET last_seen_at = now() WHERE id = v_session_id;
    END IF;
    RETURN QUERY SELECT v_session_id, v_user_id, v_verified;
  END $$;

-- Lists only sessions that are still usable, hiding ones that have gone idle.
CREATE FUNCTION eventhub.auth_list_sessions(p_user_id uuid, p_idle_seconds integer)
  RETURNS TABLE (out_session_id uuid, out_created_at timestamptz, out_last_seen_at timestamptz,
                 out_expires_at timestamptz, out_user_agent text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT s.id, s.created_at, coalesce(s.last_seen_at, s.created_at), s.expires_at, s.user_agent
      FROM eventhub.auth_session s
     WHERE s.user_id = p_user_id AND s.revoked_at IS NULL AND s.expires_at > now()
       AND (s.last_seen_at IS NULL OR s.last_seen_at >= now() - make_interval(secs => p_idle_seconds))
     ORDER BY coalesce(s.last_seen_at, s.created_at) DESC, s.id
  $$;

REVOKE ALL ON FUNCTION eventhub.auth_resolve_and_touch_session(bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_list_sessions(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.auth_resolve_and_touch_session(bytea, integer) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_list_sessions(uuid, integer) TO eventhub_app;
