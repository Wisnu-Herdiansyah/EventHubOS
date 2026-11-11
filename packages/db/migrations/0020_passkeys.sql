-- Passkeys as a second step of sign-in (ADR-0033). Expand-only.
--
-- A passkey is offered instead of an authenticator-app code once two-step verification is on.
-- Like the other identity tables these have forced RLS and no policies; the API reaches them only
-- through the SECURITY DEFINER functions below. Public keys are not secret; challenges are random
-- and single-use, and expire after five minutes.
--
-- eventhub:allow-destructive DELETEs run only inside functions on one user's passkeys (removing one, or all of them when two-step verification is turned off), never on existing data at migration time (ADR-0033)

CREATE TABLE eventhub.auth_passkey (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES eventhub.app_user (id),
  credential_id  bytea NOT NULL UNIQUE CHECK (octet_length(credential_id) BETWEEN 16 AND 1023),
  public_key     bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 16 AND 2048),
  counter        bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(transports) <= 8),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX auth_passkey_user_idx ON eventhub.auth_passkey (user_id);
ALTER TABLE eventhub.auth_passkey ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.auth_passkey FORCE ROW LEVEL SECURITY;

-- One outstanding WebAuthn challenge per user and purpose; for sign-in, per sign-in challenge.
CREATE TABLE eventhub.auth_webauthn_challenge (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES eventhub.app_user (id),
  purpose           text NOT NULL CHECK (purpose IN ('register', 'login')),
  mfa_challenge_id  uuid REFERENCES eventhub.auth_mfa_challenge (id),
  challenge         text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  CHECK ((purpose = 'login') = (mfa_challenge_id IS NOT NULL))
);
CREATE INDEX auth_webauthn_challenge_user_idx ON eventhub.auth_webauthn_challenge (user_id, purpose);
ALTER TABLE eventhub.auth_webauthn_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.auth_webauthn_challenge FORCE ROW LEVEL SECURITY;

-- Issues a challenge, retiring any earlier one for the same user and purpose (and sign-in).
CREATE FUNCTION eventhub.auth_webauthn_challenge_issue(p_user_id uuid, p_purpose text,
                                                       p_mfa_challenge_id uuid, p_challenge text,
                                                       p_ttl_seconds integer)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.auth_webauthn_challenge SET consumed_at = now()
     WHERE user_id = p_user_id AND purpose = p_purpose AND consumed_at IS NULL
       AND mfa_challenge_id IS NOT DISTINCT FROM p_mfa_challenge_id;
    INSERT INTO eventhub.auth_webauthn_challenge (user_id, purpose, mfa_challenge_id, challenge,
                                                  expires_at)
    VALUES (p_user_id, p_purpose, p_mfa_challenge_id, p_challenge,
            now() + make_interval(secs => p_ttl_seconds));
  $$;

-- Takes the outstanding challenge once: a second call finds nothing.
CREATE FUNCTION eventhub.auth_webauthn_challenge_take(p_user_id uuid, p_purpose text,
                                                      p_mfa_challenge_id uuid)
  RETURNS text
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    UPDATE eventhub.auth_webauthn_challenge SET consumed_at = now()
     WHERE id = (SELECT id FROM eventhub.auth_webauthn_challenge
                  WHERE user_id = p_user_id AND purpose = p_purpose AND consumed_at IS NULL
                    AND expires_at > now()
                    AND mfa_challenge_id IS NOT DISTINCT FROM p_mfa_challenge_id
                  ORDER BY created_at DESC LIMIT 1
                  FOR UPDATE)
    RETURNING challenge
  $$;

CREATE FUNCTION eventhub.auth_passkey_list(p_user_id uuid)
  RETURNS TABLE (out_id uuid, out_credential_id bytea, out_public_key bytea, out_counter bigint,
                 out_transports text[], out_name text, out_created_at timestamptz,
                 out_last_used_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT id, credential_id, public_key, counter, transports, name, created_at, last_used_at
      FROM eventhub.auth_passkey WHERE user_id = p_user_id ORDER BY created_at, id
  $$;

-- Adds a passkey to an account that has two-step verification on; at most 10 per account.
CREATE FUNCTION eventhub.auth_passkey_add(p_user_id uuid, p_credential_id bytea,
                                          p_public_key bytea, p_counter bigint,
                                          p_transports text[], p_name text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
  DECLARE v_id uuid;
  BEGIN
    PERFORM 1 FROM eventhub.app_user WHERE id = p_user_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM eventhub.auth_mfa_factor
                    WHERE user_id = p_user_id AND status = 'active') THEN
      RETURN NULL;
    END IF;
    IF (SELECT count(*) FROM eventhub.auth_passkey WHERE user_id = p_user_id) >= 10 THEN
      RETURN NULL;
    END IF;
    INSERT INTO eventhub.auth_passkey (user_id, credential_id, public_key, counter, transports, name)
    VALUES (p_user_id, p_credential_id, p_public_key, p_counter, p_transports, p_name)
    ON CONFLICT (credential_id) DO NOTHING
    RETURNING id INTO v_id;
    RETURN v_id;
  END $$;

-- Records a sign-in. A counter that does not move forward (other than authenticators that always
-- report 0) suggests a cloned authenticator, and is refused.
CREATE FUNCTION eventhub.auth_passkey_use(p_user_id uuid, p_credential_id bytea, p_new_counter bigint)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH u AS (
      UPDATE eventhub.auth_passkey SET counter = p_new_counter, last_used_at = now()
       WHERE user_id = p_user_id AND credential_id = p_credential_id
         AND (p_new_counter > counter OR (p_new_counter = 0 AND counter = 0))
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM u)
  $$;

CREATE FUNCTION eventhub.auth_passkey_remove(p_user_id uuid, p_id uuid)
  RETURNS text
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    DELETE FROM eventhub.auth_passkey WHERE user_id = p_user_id AND id = p_id RETURNING name
  $$;

CREATE FUNCTION eventhub.auth_passkey_remove_all(p_user_id uuid)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    WITH d AS (DELETE FROM eventhub.auth_passkey WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*)::integer FROM d
  $$;

REVOKE ALL ON FUNCTION eventhub.auth_webauthn_challenge_issue(uuid, text, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_webauthn_challenge_take(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_passkey_list(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_passkey_add(uuid, bytea, bytea, bigint, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_passkey_use(uuid, bytea, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_passkey_remove(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eventhub.auth_passkey_remove_all(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.auth_webauthn_challenge_issue(uuid, text, uuid, text, integer) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_webauthn_challenge_take(uuid, text, uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_passkey_list(uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_passkey_add(uuid, bytea, bytea, bigint, text[], text) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_passkey_use(uuid, bytea, bigint) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_passkey_remove(uuid, uuid) TO eventhub_app;
GRANT EXECUTE ON FUNCTION eventhub.auth_passkey_remove_all(uuid) TO eventhub_app;
