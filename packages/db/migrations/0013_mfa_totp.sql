-- Two-step verification with an authenticator app (TOTP) and recovery codes (ADR-0022).
-- Expand-only. Like the other identity tables these have forced RLS and no policies: the runtime
-- role reaches them only through the SECURITY DEFINER functions below.
--
-- The TOTP secret is stored sealed (AES-256-GCM, key held by the API only). Recovery codes and
-- login challenges are stored as SHA-256 hashes. last_used_step blocks code replay.
--
-- eventhub:allow-destructive DELETEs run only inside functions on MFA rows of one user (replacing recovery codes, turning MFA off by the account owner), never on existing data at migration time (ADR-0022)

CREATE TABLE eventhub.auth_mfa_factor (
  user_id         uuid PRIMARY KEY REFERENCES eventhub.app_user (id),
  secret_sealed   bytea NOT NULL CHECK (octet_length(secret_sealed) BETWEEN 30 AND 200),
  status          text NOT NULL CHECK (status IN ('pending', 'active')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  last_used_step  bigint NOT NULL DEFAULT 0,
  CHECK ((status = 'active') = (activated_at IS NOT NULL))
);
ALTER TABLE eventhub.auth_mfa_factor ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.auth_mfa_factor FORCE ROW LEVEL SECURITY;

CREATE TABLE eventhub.auth_mfa_recovery_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES eventhub.app_user (id),
  code_hash   bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
CREATE INDEX auth_mfa_recovery_code_user_idx ON eventhub.auth_mfa_recovery_code (user_id);
ALTER TABLE eventhub.auth_mfa_recovery_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.auth_mfa_recovery_code FORCE ROW LEVEL SECURITY;

-- A correct password on an account with MFA yields a challenge, not a session.
CREATE TABLE eventhub.auth_mfa_challenge (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash             bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  user_id                uuid NOT NULL REFERENCES eventhub.app_user (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at            timestamptz,
  user_agent             text CHECK (user_agent IS NULL OR char_length(user_agent) <= 256),
  -- A stronger re-hash of the password computed at sign-in, applied once the challenge passes.
  pending_password_hash  text CHECK (pending_password_hash IS NULL OR pending_password_hash LIKE '$argon2id$%')
);
CREATE INDEX auth_mfa_challenge_user_idx ON eventhub.auth_mfa_challenge (user_id);
ALTER TABLE eventhub.auth_mfa_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.auth_mfa_challenge FORCE ROW LEVEL SECURITY;

-- Status for the account page and for verifying codes (the sealed secret is opened by the API).
CREATE FUNCTION eventhub.auth_mfa_status(p_user_id uuid)
  RETURNS TABLE (out_status text, out_activated_at timestamptz, out_codes_remaining integer,
                 out_secret_sealed bytea)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT f.status, f.activated_at,
           (SELECT count(*)::integer FROM eventhub.auth_mfa_recovery_code r
             WHERE r.user_id = f.user_id AND r.used_at IS NULL),
           f.secret_sealed
      FROM eventhub.auth_mfa_factor f
     WHERE f.user_id = p_user_id
  $$;

CREATE FUNCTION eventhub.auth_mfa_required(p_user_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM eventhub.auth_mfa_factor
                    WHERE user_id = p_user_id AND status = 'active')
  $$;

-- Starts (or restarts) enrolment with a new sealed secret. Refused while MFA is active.
CREATE FUNCTION eventhub.auth_mfa_begin_enrolment(p_user_id uuid, p_secret_sealed bytea)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM eventhub.auth_mfa_factor WHERE user_id = p_user_id AND status = 'active') THEN
      RETURN false;
    END IF;
    INSERT INTO eventhub.auth_mfa_factor (user_id, secret_sealed, status)
    VALUES (p_user_id, p_secret_sealed, 'pending')
    ON CONFLICT (user_id) DO UPDATE
       SET secret_sealed = excluded.secret_sealed, created_at = now(), last_used_step = 0;
    RETURN true;
  END $$;

-- Activates a pending factor with the step of the code just verified, replaces recovery codes and
-- signs out other sessions. No row when there is nothing pending or the step was already used.
CREATE FUNCTION eventhub.auth_mfa_activate(p_user_id uuid, p_step bigint, p_code_hashes bytea[],
                                           p_keep_session_id uuid)
  RETURNS TABLE (out_other_sessions_revoked integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    UPDATE eventhub.auth_mfa_factor
       SET status = 'active', activated_at = now(), last_used_step = p_step
     WHERE user_id = p_user_id AND status = 'pending' AND last_used_step < p_step;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    DELETE FROM eventhub.auth_mfa_recovery_code WHERE user_id = p_user_id;
    INSERT INTO eventhub.auth_mfa_recovery_code (user_id, code_hash)
    SELECT p_user_id, h FROM unnest(p_code_hashes) AS h;
    RETURN QUERY SELECT eventhub.auth_revoke_other_sessions(p_user_id, p_keep_session_id);
  END $$;

-- Records a verified TOTP step; false if it (or a later one) was already used: no replay.
CREATE FUNCTION eventhub.auth_mfa_use_step(p_user_id uuid, p_step bigint)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH used AS (
      UPDATE eventhub.auth_mfa_factor SET last_used_step = p_step
       WHERE user_id = p_user_id AND status = 'active' AND last_used_step < p_step
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM used)
  $$;

-- Spends a recovery code once.
CREATE FUNCTION eventhub.auth_mfa_use_recovery_code(p_user_id uuid, p_code_hash bytea)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH used AS (
      UPDATE eventhub.auth_mfa_recovery_code SET used_at = now()
       WHERE user_id = p_user_id AND code_hash = p_code_hash AND used_at IS NULL
         AND EXISTS (SELECT 1 FROM eventhub.auth_mfa_factor f
                      WHERE f.user_id = p_user_id AND f.status = 'active')
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM used)
  $$;

CREATE FUNCTION eventhub.auth_mfa_replace_recovery_codes(p_user_id uuid, p_code_hashes bytea[])
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM eventhub.auth_mfa_factor WHERE user_id = p_user_id AND status = 'active') THEN
      RETURN false;
    END IF;
    DELETE FROM eventhub.auth_mfa_recovery_code WHERE user_id = p_user_id;
    INSERT INTO eventhub.auth_mfa_recovery_code (user_id, code_hash)
    SELECT p_user_id, h FROM unnest(p_code_hashes) AS h;
    RETURN true;
  END $$;

-- Turns MFA off: factor, recovery codes and open challenges go.
CREATE FUNCTION eventhub.auth_mfa_disable(p_user_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  BEGIN
    DELETE FROM eventhub.auth_mfa_recovery_code WHERE user_id = p_user_id;
    UPDATE eventhub.auth_mfa_challenge SET consumed_at = now()
     WHERE user_id = p_user_id AND consumed_at IS NULL;
    DELETE FROM eventhub.auth_mfa_factor WHERE user_id = p_user_id;
    RETURN FOUND;
  END $$;

CREATE FUNCTION eventhub.auth_mfa_create_challenge(p_user_id uuid, p_token_hash bytea,
                                                   p_ttl_seconds integer, p_user_agent text,
                                                   p_pending_password_hash text)
  RETURNS timestamptz
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    INSERT INTO eventhub.auth_mfa_challenge
      (user_id, token_hash, expires_at, user_agent, pending_password_hash)
    VALUES (p_user_id, p_token_hash, now() + make_interval(secs => p_ttl_seconds),
            left(p_user_agent, 256), p_pending_password_hash)
    RETURNING expires_at
  $$;

-- A live challenge (unexpired, unused, fewer than 5 attempts) with what completing it needs.
CREATE FUNCTION eventhub.auth_mfa_challenge_lookup(p_token_hash bytea)
  RETURNS TABLE (out_challenge_id uuid, out_user_id uuid, out_secret_sealed bytea,
                 out_locked boolean, out_email_verified boolean, out_user_agent text,
                 out_pending_password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT ch.id, ch.user_id, f.secret_sealed, coalesce(c.locked_until > now(), false),
           u.email_verified_at IS NOT NULL, ch.user_agent, ch.pending_password_hash
      FROM eventhub.auth_mfa_challenge ch
      JOIN eventhub.auth_mfa_factor f ON f.user_id = ch.user_id AND f.status = 'active'
      JOIN eventhub.user_credential c ON c.user_id = ch.user_id
      JOIN eventhub.app_user u ON u.id = ch.user_id
     WHERE ch.token_hash = p_token_hash
       AND ch.consumed_at IS NULL
       AND ch.expires_at > now()
       AND ch.attempts < 5
  $$;

CREATE FUNCTION eventhub.auth_mfa_challenge_failed(p_challenge_id uuid)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.auth_mfa_challenge SET attempts = attempts + 1
     WHERE id = p_challenge_id
    RETURNING attempts
  $$;

-- Single use: false when another request already consumed it.
CREATE FUNCTION eventhub.auth_mfa_challenge_consume(p_challenge_id uuid)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH c AS (
      UPDATE eventhub.auth_mfa_challenge SET consumed_at = now()
       WHERE id = p_challenge_id AND consumed_at IS NULL AND expires_at > now()
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM c)
  $$;

REVOKE ALL ON FUNCTION eventhub.auth_mfa_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_required(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_begin_enrolment(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_activate(uuid, bigint, bytea[], uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_use_step(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_use_recovery_code(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_replace_recovery_codes(uuid, bytea[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_disable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_create_challenge(uuid, bytea, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_challenge_lookup(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_challenge_failed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_mfa_challenge_consume(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_status(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_required(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_begin_enrolment(uuid, bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_activate(uuid, bigint, bytea[], uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_use_step(uuid, bigint) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_use_recovery_code(uuid, bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_replace_recovery_codes(uuid, bytea[]) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_disable(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_create_challenge(uuid, bytea, integer, text, text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_challenge_lookup(bytea) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_challenge_failed(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_mfa_challenge_consume(uuid) TO eventhub_app;
