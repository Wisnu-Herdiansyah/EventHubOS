-- Password identity (ADR-0007): Argon2id credentials, email verification, login throttling.
--
-- Credentials and verification tokens are global (not tenant-owned). The runtime roles get no
-- table privileges on them; every operation goes through a narrow SECURITY DEFINER function
-- with a fixed search_path. Password hashing happens in the application; the database only
-- stores PHC strings and never sees plaintext passwords or raw tokens.

CREATE TABLE eventhub.user_credential (
  user_id              uuid PRIMARY KEY REFERENCES eventhub.app_user (id),
  password_hash        text NOT NULL CHECK (password_hash LIKE '$argon2id$%' AND char_length(password_hash) <= 512),
  -- Bumped whenever the password is replaced; verification tokens are bound to it so a token
  -- issued for an earlier credential (e.g. a pre-hijacking attacker's) can never verify.
  credential_version   integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  failed_login_count   integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE eventhub.user_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.user_credential FORCE ROW LEVEL SECURITY;  -- no policies: deny all direct access

CREATE TABLE eventhub.email_verification_token (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES eventhub.app_user (id),
  token_hash          bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  credential_version  integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX email_verification_token_user_idx ON eventhub.email_verification_token (user_id)
  WHERE consumed_at IS NULL;
ALTER TABLE eventhub.email_verification_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.email_verification_token FORCE ROW LEVEL SECURITY;

-- Identity events are platform-scoped (no organization). The runtime role may append them, but
-- only under the `identity.` namespace, so tenant audit/outbox rules are unchanged.
CREATE POLICY audit_event_identity_insert ON eventhub.audit_event FOR INSERT TO eventhub_app
  WITH CHECK (organization_id IS NULL AND action LIKE 'identity.%');
CREATE POLICY outbox_event_identity_insert ON eventhub.outbox_event FOR INSERT TO eventhub_app
  WITH CHECK (organization_id IS NULL AND event_type LIKE 'identity.%');

-- ---------------------------------------------------------------------------------------------
-- Registration
-- ---------------------------------------------------------------------------------------------
-- Outcomes: 'created'; 'replaced_unverified' (an unverified account's password is replaced,
-- its sessions and outstanding tokens are revoked: mitigates account pre-hijacking);
-- 'exists_verified' (nothing changes). Callers return the same response for all three.
CREATE FUNCTION eventhub.auth_register(p_email text, p_password_hash text)
  RETURNS TABLE (out_user_id uuid, out_outcome text, out_credential_version integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_user_id uuid;
    v_verified timestamptz;
    v_version integer;
  BEGIN
    INSERT INTO eventhub.app_user (email) VALUES (p_email)
      ON CONFLICT (email) DO NOTHING
      RETURNING id INTO v_user_id;
    IF v_user_id IS NOT NULL THEN
      INSERT INTO eventhub.user_credential (user_id, password_hash) VALUES (v_user_id, p_password_hash);
      RETURN QUERY SELECT v_user_id, 'created'::text, 1;
      RETURN;
    END IF;

    SELECT u.id, u.email_verified_at INTO v_user_id, v_verified
      FROM eventhub.app_user u WHERE u.email = p_email FOR UPDATE;
    IF v_verified IS NOT NULL THEN
      RETURN QUERY SELECT v_user_id, 'exists_verified'::text, NULL::integer;
      RETURN;
    END IF;

    INSERT INTO eventhub.user_credential AS c (user_id, password_hash) VALUES (v_user_id, p_password_hash)
      ON CONFLICT (user_id) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            credential_version = c.credential_version + 1,
            failed_login_count = 0,
            locked_until = NULL,
            password_changed_at = now(),
            updated_at = now()
      RETURNING c.credential_version INTO v_version;
    UPDATE eventhub.auth_session SET revoked_at = now()
      WHERE user_id = v_user_id AND revoked_at IS NULL;
    UPDATE eventhub.email_verification_token SET consumed_at = now()
      WHERE user_id = v_user_id AND consumed_at IS NULL;
    RETURN QUERY SELECT v_user_id, 'replaced_unverified'::text, v_version;
  END $$;

-- ---------------------------------------------------------------------------------------------
-- Login
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION eventhub.auth_login_lookup(p_email text)
  RETURNS TABLE (out_user_id uuid, out_password_hash text, out_locked boolean, out_email_verified boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT u.id, c.password_hash, coalesce(c.locked_until > now(), false), u.email_verified_at IS NOT NULL
      FROM eventhub.app_user u
      JOIN eventhub.user_credential c ON c.user_id = u.id
     WHERE u.email = p_email
  $$;

-- Progressive lockout: reaching p_max_failures locks the account for p_lock_seconds. The count
-- is not reset by the lock, so each further failure after expiry re-locks immediately.
CREATE FUNCTION eventhub.auth_record_login_failure(p_user_id uuid, p_max_failures integer, p_lock_seconds integer)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.user_credential
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= p_max_failures
                               THEN now() + make_interval(secs => p_lock_seconds)
                               ELSE locked_until END,
           updated_at = now()
     WHERE user_id = p_user_id
    RETURNING locked_until IS NOT NULL AND locked_until > now()
  $$;

-- Resets throttling, optionally upgrades the hash (same password, stronger parameters; the
-- credential version is unchanged), and issues a session.
CREATE FUNCTION eventhub.auth_complete_login(
    p_user_id uuid, p_token_hash bytea, p_ttl_seconds integer, p_upgraded_hash text)
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
      INSERT INTO eventhub.auth_session (user_id, token_hash, expires_at)
      VALUES (p_user_id, p_token_hash, now() + make_interval(secs => p_ttl_seconds))
      RETURNING id, expires_at;
  END $$;

-- Expand step: supersedes eventhub.resolve_session (kept until a later contract migration).
CREATE FUNCTION eventhub.auth_resolve_session(p_token_hash bytea)
  RETURNS TABLE (out_session_id uuid, out_user_id uuid, out_email_verified boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT s.id, u.id, u.email_verified_at IS NOT NULL
      FROM eventhub.auth_session s
      JOIN eventhub.app_user u ON u.id = s.user_id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
  $$;

CREATE FUNCTION eventhub.auth_revoke_session(p_session_id uuid, p_user_id uuid)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.auth_session SET revoked_at = now()
     WHERE id = p_session_id AND user_id = p_user_id AND revoked_at IS NULL
  $$;

-- ---------------------------------------------------------------------------------------------
-- Email verification
-- ---------------------------------------------------------------------------------------------
-- Worker-only: records a token hash and returns the address to send to, but only while the
-- account is unverified and the credential version still matches the request. A NULL version
-- means "current" and is used only for resends requested from an authenticated session (every
-- password replacement revokes sessions, so a live session proves the current credential).
CREATE FUNCTION eventhub.auth_issue_verification(
    p_user_id uuid, p_credential_version integer, p_token_hash bytea, p_ttl_seconds integer)
  RETURNS TABLE (out_email text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_email text;
    v_version integer;
  BEGIN
    SELECT u.email, c.credential_version INTO v_email, v_version
      FROM eventhub.app_user u
      JOIN eventhub.user_credential c ON c.user_id = u.id
     WHERE u.id = p_user_id
       AND u.email_verified_at IS NULL
       AND (p_credential_version IS NULL OR c.credential_version = p_credential_version);
    IF v_email IS NULL THEN
      RETURN;
    END IF;
    INSERT INTO eventhub.email_verification_token (user_id, token_hash, credential_version, expires_at)
    VALUES (p_user_id, p_token_hash, v_version, now() + make_interval(secs => p_ttl_seconds));
    RETURN QUERY SELECT v_email;
  END $$;

-- Single-use: a matching, unexpired token for the current credential verifies the email and
-- revokes every existing session (anything opened before proof of mailbox control).
CREATE FUNCTION eventhub.auth_consume_verification(p_token_hash bytea)
  RETURNS TABLE (out_user_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE
    v_token_id uuid;
    v_user_id uuid;
    v_token_version integer;
    v_current_version integer;
  BEGIN
    SELECT t.id, t.user_id, t.credential_version INTO v_token_id, v_user_id, v_token_version
      FROM eventhub.email_verification_token t
     WHERE t.token_hash = p_token_hash AND t.consumed_at IS NULL AND t.expires_at > now()
     FOR UPDATE;
    IF v_token_id IS NULL THEN
      RETURN;
    END IF;
    UPDATE eventhub.email_verification_token SET consumed_at = now() WHERE id = v_token_id;
    SELECT c.credential_version INTO v_current_version
      FROM eventhub.user_credential c WHERE c.user_id = v_user_id;
    IF v_current_version IS DISTINCT FROM v_token_version THEN
      RETURN;
    END IF;
    UPDATE eventhub.app_user SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = v_user_id;
    UPDATE eventhub.auth_session SET revoked_at = now() WHERE user_id = v_user_id AND revoked_at IS NULL;
    RETURN QUERY SELECT v_user_id;
  END $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: functions only, each to the single role that needs it.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION eventhub.auth_register(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_record_login_failure(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_complete_login(uuid, bytea, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_resolve_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_revoke_session(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_issue_verification(uuid, integer, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_consume_verification(bytea) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION eventhub.auth_register(text, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_login_lookup(text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_record_login_failure(uuid, integer, integer) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_complete_login(uuid, bytea, integer, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_resolve_session(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_revoke_session(uuid, uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_consume_verification(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_issue_verification(uuid, integer, bytea, integer) TO eventhub_worker;
