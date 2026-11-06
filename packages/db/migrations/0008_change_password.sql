-- Change password while signed in (ADR-0016). Expand-only: two functions, no schema changes.
--
-- The caller re-authenticates with the current password. Wrong attempts reuse the login lockout
-- (eventhub.auth_record_login_failure), so a stolen session cannot be used to guess the password.

-- API (eventhub_app): the signed-in user's credential, for re-authentication.
CREATE FUNCTION eventhub.auth_credential_for_user(p_user_id uuid)
  RETURNS TABLE (out_password_hash text, out_locked boolean, out_email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT c.password_hash, coalesce(c.locked_until > now(), false), u.email
      FROM eventhub.app_user u
      JOIN eventhub.user_credential c ON c.user_id = u.id
     WHERE u.id = p_user_id
  $$;

-- API (eventhub_app): replace the password after re-authentication.
-- Bumps the credential version (every outstanding reset and verification link dies), clears login
-- throttling, and revokes every session except the one making the change. Returns how many other
-- sessions were revoked, or no row when that session is no longer valid for this user.
CREATE FUNCTION eventhub.auth_change_password(p_user_id uuid, p_session_id uuid, p_password_hash text)
  RETURNS TABLE (out_other_sessions_revoked integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_revoked integer;
  BEGIN
    PERFORM 1 FROM eventhub.auth_session s
     WHERE s.id = p_session_id AND s.user_id = p_user_id
       AND s.revoked_at IS NULL AND s.expires_at > now()
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    UPDATE eventhub.user_credential
       SET password_hash = p_password_hash,
           credential_version = credential_version + 1,
           failed_login_count = 0,
           locked_until = NULL,
           password_changed_at = now(),
           updated_at = now()
     WHERE user_id = p_user_id;
    UPDATE eventhub.auth_session SET revoked_at = now()
     WHERE user_id = p_user_id AND id <> p_session_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_revoked = ROW_COUNT;
    UPDATE eventhub.password_reset_token SET consumed_at = now()
     WHERE user_id = p_user_id AND consumed_at IS NULL;
    UPDATE eventhub.email_verification_token SET consumed_at = now()
     WHERE user_id = p_user_id AND consumed_at IS NULL;
    RETURN QUERY SELECT v_revoked;
  END $$;

REVOKE ALL ON FUNCTION eventhub.auth_credential_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_change_password(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.auth_credential_for_user(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_change_password(uuid, uuid, text) TO eventhub_app;
