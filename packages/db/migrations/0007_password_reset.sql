-- Password reset (ADR-0015). Expand-only.
--
-- Same model as email verification (ADR-0007/0008): the API enqueues identifiers only, the worker
-- mints a deterministic single-use token at send time and stores only its SHA-256 hash, and the
-- runtime roles reach the data through narrow SECURITY DEFINER functions with a fixed search_path.
-- Tokens are bound to the credential version, so any password change kills every older link.

CREATE TABLE eventhub.password_reset_token (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES eventhub.app_user (id),
  token_hash          bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  credential_version  integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX password_reset_token_user_idx ON eventhub.password_reset_token (user_id)
  WHERE consumed_at IS NULL;
ALTER TABLE eventhub.password_reset_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.password_reset_token FORCE ROW LEVEL SECURITY;  -- no policies: deny all direct access

-- Per-account request throttle, counted synchronously under the credential row lock so a burst
-- from many IP addresses cannot flood one inbox.
ALTER TABLE eventhub.user_credential
  ADD COLUMN reset_window_started_at  timestamptz,
  ADD COLUMN reset_requests_in_window integer NOT NULL DEFAULT 0 CHECK (reset_requests_in_window >= 0);

-- ---------------------------------------------------------------------------------------------
-- API (eventhub_app): record a reset request.
-- Returns no row for an unknown address. Otherwise out_allowed says whether the request fits the
-- per-account window (p_max requests per p_window_seconds); callers answer identically either way.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION eventhub.auth_request_password_reset(p_email text, p_max integer, p_window_seconds integer)
  RETURNS TABLE (out_user_id uuid, out_credential_version integer, out_allowed boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_user_id uuid;
    v_version integer;
    v_started timestamptz;
    v_count integer;
  BEGIN
    SELECT u.id, c.credential_version, c.reset_window_started_at, c.reset_requests_in_window
      INTO v_user_id, v_version, v_started, v_count
      FROM eventhub.app_user u
      JOIN eventhub.user_credential c ON c.user_id = u.id
     WHERE u.email = p_email
       FOR UPDATE OF c;
    IF v_user_id IS NULL THEN
      RETURN;
    END IF;
    IF v_started IS NULL OR v_started <= now() - make_interval(secs => p_window_seconds) THEN
      v_started := now();
      v_count := 0;
    END IF;
    IF v_count >= p_max THEN
      RETURN QUERY SELECT v_user_id, v_version, false;
      RETURN;
    END IF;
    UPDATE eventhub.user_credential
       SET reset_window_started_at = v_started,
           reset_requests_in_window = v_count + 1,
           updated_at = now()
     WHERE user_id = v_user_id;
    RETURN QUERY SELECT v_user_id, v_version, true;
  END $$;

-- ---------------------------------------------------------------------------------------------
-- Worker (eventhub_worker): store a token hash and return the address to send to, but only while
-- the credential version still matches the request (a reset or re-registration since then makes
-- the request stale).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION eventhub.auth_issue_password_reset(
    p_user_id uuid, p_credential_version integer, p_token_hash bytea, p_ttl_seconds integer)
  RETURNS TABLE (out_email text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_email text;
  BEGIN
    SELECT u.email INTO v_email
      FROM eventhub.app_user u
      JOIN eventhub.user_credential c ON c.user_id = u.id
     WHERE u.id = p_user_id AND c.credential_version = p_credential_version;
    IF v_email IS NULL THEN
      RETURN;
    END IF;
    INSERT INTO eventhub.password_reset_token (user_id, token_hash, credential_version, expires_at)
    VALUES (p_user_id, p_token_hash, p_credential_version, now() + make_interval(secs => p_ttl_seconds));
    RETURN QUERY SELECT v_email;
  END $$;

-- ---------------------------------------------------------------------------------------------
-- API (eventhub_app): complete a reset with a valid token.
-- Consumes the token, replaces the password, bumps the credential version (killing every other
-- reset and verification link), marks the address verified (mailbox control is proven), clears
-- login throttling, and revokes every session. Returns no row for an invalid, used, expired or
-- stale token. The caller validates the new password and may roll back (e.g. password = email),
-- which leaves the token unused.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION eventhub.auth_complete_password_reset(p_token_hash bytea, p_password_hash text)
  RETURNS TABLE (out_user_id uuid, out_email text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_token_id uuid;
    v_user_id uuid;
    v_token_version integer;
    v_current_version integer;
    v_email text;
  BEGIN
    SELECT t.id, t.user_id, t.credential_version INTO v_token_id, v_user_id, v_token_version
      FROM eventhub.password_reset_token t
     WHERE t.token_hash = p_token_hash AND t.consumed_at IS NULL AND t.expires_at > now()
       FOR UPDATE;
    IF v_token_id IS NULL THEN
      RETURN;
    END IF;
    UPDATE eventhub.password_reset_token SET consumed_at = now() WHERE id = v_token_id;
    SELECT c.credential_version INTO v_current_version
      FROM eventhub.user_credential c WHERE c.user_id = v_user_id FOR UPDATE;
    IF v_current_version IS DISTINCT FROM v_token_version THEN
      RETURN;
    END IF;
    UPDATE eventhub.user_credential
       SET password_hash = p_password_hash,
           credential_version = credential_version + 1,
           failed_login_count = 0,
           locked_until = NULL,
           password_changed_at = now(),
           reset_window_started_at = NULL,
           reset_requests_in_window = 0,
           updated_at = now()
     WHERE user_id = v_user_id;
    UPDATE eventhub.app_user SET email_verified_at = coalesce(email_verified_at, now())
     WHERE id = v_user_id
    RETURNING email INTO v_email;
    UPDATE eventhub.auth_session SET revoked_at = now()
     WHERE user_id = v_user_id AND revoked_at IS NULL;
    UPDATE eventhub.password_reset_token SET consumed_at = now()
     WHERE user_id = v_user_id AND consumed_at IS NULL;
    UPDATE eventhub.email_verification_token SET consumed_at = now()
     WHERE user_id = v_user_id AND consumed_at IS NULL;
    RETURN QUERY SELECT v_user_id, v_email;
  END $$;

-- ---------------------------------------------------------------------------------------------
-- Worker (eventhub_worker): address for the "your password was changed" notice.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION eventhub.auth_notification_email(p_user_id uuid)
  RETURNS TABLE (out_email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT u.email FROM eventhub.app_user u WHERE u.id = p_user_id
  $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: functions only, each to the single role that needs it.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION eventhub.auth_request_password_reset(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_issue_password_reset(uuid, integer, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_complete_password_reset(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_notification_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.auth_request_password_reset(text, integer, integer) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_complete_password_reset(bytea, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_issue_password_reset(uuid, integer, bytea, integer) TO eventhub_worker;
GRANT EXECUTE ON FUNCTION eventhub.auth_notification_email(uuid) TO eventhub_worker;
