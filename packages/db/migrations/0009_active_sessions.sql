-- Active sessions: list and sign out (ADR-0017). Expand-only.
--
-- Two descriptive columns help people recognise their sessions: when the session was last used
-- (refreshed at most every 5 minutes, so ordinary requests do not each write) and the browser's
-- user-agent at sign-in (self-reported, informational only, truncated). No IP address is stored.

ALTER TABLE eventhub.auth_session
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN user_agent   text CHECK (user_agent IS NULL OR char_length(user_agent) <= 256);

-- Supersedes auth_resolve_session (kept for the expand step): resolves the bearer token and, when
-- the session was last seen more than 5 minutes ago, records that it is in use now.
CREATE FUNCTION eventhub.auth_resolve_and_touch_session(p_token_hash bytea)
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
    IF v_last_seen IS NULL OR v_last_seen < now() - interval '5 minutes' THEN
      UPDATE eventhub.auth_session SET last_seen_at = now() WHERE id = v_session_id;
    END IF;
    RETURN QUERY SELECT v_session_id, v_user_id, v_verified;
  END $$;

-- Overload of auth_complete_login that also records the user-agent (the 4-argument version is
-- kept for the expand step).
CREATE FUNCTION eventhub.auth_complete_login(
    p_user_id uuid, p_token_hash bytea, p_ttl_seconds integer, p_upgraded_hash text, p_user_agent text)
  RETURNS TABLE (out_session_id uuid, out_expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    UPDATE eventhub.user_credential
       SET failed_login_count = 0,
           locked_until = NULL,
           password_hash = coalesce(p_upgraded_hash, password_hash),
           updated_at = now()
     WHERE user_id = p_user_id;
    RETURN QUERY
      INSERT INTO eventhub.auth_session (user_id, token_hash, expires_at, last_seen_at, user_agent)
      VALUES (p_user_id, p_token_hash, now() + make_interval(secs => p_ttl_seconds), now(),
              nullif(left(p_user_agent, 256), ''))
      RETURNING id, expires_at;
  END $$;

-- The caller's own live sessions, newest activity first. Token hashes are never returned.
CREATE FUNCTION eventhub.auth_list_sessions(p_user_id uuid)
  RETURNS TABLE (out_session_id uuid, out_created_at timestamptz, out_last_seen_at timestamptz,
                 out_expires_at timestamptz, out_user_agent text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT s.id, s.created_at, coalesce(s.last_seen_at, s.created_at), s.expires_at, s.user_agent
      FROM eventhub.auth_session s
     WHERE s.user_id = p_user_id AND s.revoked_at IS NULL AND s.expires_at > now()
     ORDER BY coalesce(s.last_seen_at, s.created_at) DESC, s.id
  $$;

-- Signs out one of the caller's own live sessions. False when there is no such live session for
-- this user (someone else's session looks exactly like a missing one).
CREATE FUNCTION eventhub.auth_revoke_user_session(p_user_id uuid, p_session_id uuid)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH revoked AS (
      UPDATE eventhub.auth_session SET revoked_at = now()
       WHERE id = p_session_id AND user_id = p_user_id
         AND revoked_at IS NULL AND expires_at > now()
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM revoked)
  $$;

-- Signs out every live session of the caller except the one making the request.
CREATE FUNCTION eventhub.auth_revoke_other_sessions(p_user_id uuid, p_keep_session_id uuid)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH revoked AS (
      UPDATE eventhub.auth_session SET revoked_at = now()
       WHERE user_id = p_user_id AND id <> p_keep_session_id
         AND revoked_at IS NULL AND expires_at > now()
      RETURNING 1
    )
    SELECT count(*)::integer FROM revoked
  $$;

REVOKE ALL ON FUNCTION eventhub.auth_resolve_and_touch_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_complete_login(uuid, bytea, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_list_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_revoke_user_session(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_revoke_other_sessions(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.auth_resolve_and_touch_session(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_complete_login(uuid, bytea, integer, text, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_list_sessions(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_revoke_user_session(uuid, uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_revoke_other_sessions(uuid, uuid) TO eventhub_app;
