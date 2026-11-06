-- EventHub OS foundation schema: identity, tenancy, events, audit, outbox, idempotency.
--
-- Invariants (see docs/adr/0003-tenant-isolation-rls.md):
--   * Every tenant-owned table has organization_id NOT NULL, ENABLE + FORCE ROW LEVEL SECURITY,
--     and policies comparing rows to the transaction-local app.organization_id setting.
--   * The runtime role (eventhub_app) is not the table owner, cannot bypass RLS, and only
--     receives the column privileges it needs. Tenant ownership columns are never updatable.
--   * Missing tenant context fails closed (NULL comparison matches no rows).
--   * audit_event is append-only for every role, including the owner.
--
-- Roles eventhub_app and eventhub_worker are created by the bootstrap step, not here.

-- ---------------------------------------------------------------------------------------------
-- Context helpers
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION eventhub.current_organization_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION eventhub.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION eventhub.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); NEW.version := OLD.version + 1; RETURN NEW; END $$;

CREATE FUNCTION eventhub.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;

CREATE FUNCTION eventhub.reject_tenant_move() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'organization_id is immutable on %', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END $$;

-- ---------------------------------------------------------------------------------------------
-- Global identity (not tenant-owned; deliberately narrow access)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE eventhub.app_user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 320),
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX app_user_email_key ON eventhub.app_user (email);
CREATE TRIGGER app_user_touch BEFORE UPDATE ON eventhub.app_user
  FOR EACH ROW EXECUTE FUNCTION eventhub.touch_updated_at();

ALTER TABLE eventhub.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.app_user FORCE ROW LEVEL SECURITY;
-- A user can read only their own identity row.
CREATE POLICY app_user_self_select ON eventhub.app_user FOR SELECT TO eventhub_app
  USING (id = eventhub.current_user_id());
GRANT SELECT ON eventhub.app_user TO eventhub_app;

-- Opaque session tokens are stored only as SHA-256 hashes. The runtime role has no direct
-- table access; it resolves sessions through a SECURITY DEFINER function.
CREATE TABLE eventhub.auth_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES eventhub.app_user (id),
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_session_user_idx ON eventhub.auth_session (user_id);

CREATE FUNCTION eventhub.resolve_session(p_token_hash bytea)
  RETURNS TABLE (user_id uuid, email_verified boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = eventhub, pg_temp
  AS $$
    SELECT u.id, u.email_verified_at IS NOT NULL
      FROM eventhub.auth_session s
      JOIN eventhub.app_user u ON u.id = s.user_id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
  $$;
REVOKE ALL ON FUNCTION eventhub.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eventhub.resolve_session(bytea) TO eventhub_app;

-- ---------------------------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------------------------
CREATE TABLE eventhub.organization (
  id            uuid PRIMARY KEY,
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  legal_name    text CHECK (legal_name IS NULL OR char_length(legal_name) BETWEEN 1 AND 300),
  locale        text NOT NULL CHECK (char_length(locale) BETWEEN 2 AND 35),
  timezone      text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending_deletion')),
  created_by    uuid NOT NULL REFERENCES eventhub.app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE TRIGGER organization_touch BEFORE UPDATE ON eventhub.organization
  FOR EACH ROW EXECUTE FUNCTION eventhub.touch_updated_at();

CREATE TABLE eventhub.membership (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES eventhub.organization (id),
  user_id          uuid NOT NULL REFERENCES eventhub.app_user (id),
  role             text NOT NULL CHECK (role IN ('owner', 'admin', 'billing_admin', 'event_manager',
                                                 'content_editor', 'registration_manager', 'analyst', 'viewer')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  invited_by       uuid REFERENCES eventhub.app_user (id),
  accepted_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX membership_user_idx ON eventhub.membership (user_id) WHERE status = 'active';
CREATE TRIGGER membership_touch BEFORE UPDATE ON eventhub.membership
  FOR EACH ROW EXECUTE FUNCTION eventhub.touch_updated_at();
CREATE TRIGGER membership_tenant_immutable BEFORE UPDATE ON eventhub.membership
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.membership FORCE ROW LEVEL SECURITY;
-- Rows are visible inside the active tenant, plus the caller's own memberships (needed to
-- resolve which organizations a user may enter, before any tenant context exists).
CREATE POLICY membership_select ON eventhub.membership FOR SELECT TO eventhub_app
  USING (organization_id = eventhub.current_organization_id()
         OR user_id = eventhub.current_user_id());
CREATE POLICY membership_insert ON eventhub.membership FOR INSERT TO eventhub_app
  WITH CHECK (organization_id = eventhub.current_organization_id());
CREATE POLICY membership_update ON eventhub.membership FOR UPDATE TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.membership TO eventhub_app;
GRANT UPDATE (role, status, accepted_at) ON eventhub.membership TO eventhub_app;

ALTER TABLE eventhub.organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.organization FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_select ON eventhub.organization FOR SELECT TO eventhub_app
  USING (id = eventhub.current_organization_id()
         OR id IN (SELECT m.organization_id FROM eventhub.membership m
                    WHERE m.user_id = eventhub.current_user_id() AND m.status = 'active'));
CREATE POLICY organization_insert ON eventhub.organization FOR INSERT TO eventhub_app
  WITH CHECK (id = eventhub.current_organization_id() AND created_by = eventhub.current_user_id());
CREATE POLICY organization_update ON eventhub.organization FOR UPDATE TO eventhub_app
  USING (id = eventhub.current_organization_id())
  WITH CHECK (id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.organization TO eventhub_app;
GRANT UPDATE (display_name, legal_name, locale, timezone) ON eventhub.organization TO eventhub_app;

-- ---------------------------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------------------------
CREATE TABLE eventhub.event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES eventhub.organization (id),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  slug              text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  lifecycle         text NOT NULL DEFAULT 'draft'
                      CHECK (lifecycle IN ('draft', 'scheduled', 'published', 'live', 'ended', 'archived')),
  timezone          text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  venue_mode        text NOT NULL CHECK (venue_mode IN ('in_person', 'virtual', 'hybrid')),
  primary_language  text NOT NULL CHECK (char_length(primary_language) BETWEEN 2 AND 35),
  created_by        uuid NOT NULL REFERENCES eventhub.app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at),
  UNIQUE (organization_id, id),   -- target for composite FKs from child tables
  UNIQUE (organization_id, slug)  -- baseline {domain}/{event-slug} routing; domains are org-owned
);
CREATE INDEX event_org_created_idx ON eventhub.event (organization_id, created_at DESC, id DESC);
CREATE TRIGGER event_touch BEFORE UPDATE ON eventhub.event
  FOR EACH ROW EXECUTE FUNCTION eventhub.touch_updated_at();
CREATE TRIGGER event_tenant_immutable BEFORE UPDATE ON eventhub.event
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_tenant_move();

ALTER TABLE eventhub.event ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.event FORCE ROW LEVEL SECURITY;
CREATE POLICY event_tenant ON eventhub.event FOR ALL TO eventhub_app
  USING (organization_id = eventhub.current_organization_id())
  WITH CHECK (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.event TO eventhub_app;
GRANT UPDATE (name, slug, lifecycle, timezone, starts_at, ends_at, venue_mode, primary_language)
  ON eventhub.event TO eventhub_app;

-- ---------------------------------------------------------------------------------------------
-- Audit (append-only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE eventhub.audit_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid,  -- no FK: audit evidence must outlive tenant purge per retention policy
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('user', 'system', 'platform_support')),
  actor_id         uuid,
  action           text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  target_type      text NOT NULL,
  target_id        uuid,
  correlation_id   text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_event_org_time_idx ON eventhub.audit_event (organization_id, occurred_at DESC);
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON eventhub.audit_event
  FOR EACH ROW EXECUTE FUNCTION eventhub.reject_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON eventhub.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION eventhub.reject_mutation();

ALTER TABLE eventhub.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_event_insert ON eventhub.audit_event FOR INSERT TO eventhub_app
  WITH CHECK (organization_id = eventhub.current_organization_id());
CREATE POLICY audit_event_select ON eventhub.audit_event FOR SELECT TO eventhub_app
  USING (organization_id = eventhub.current_organization_id());
GRANT SELECT, INSERT ON eventhub.audit_event TO eventhub_app;

-- ---------------------------------------------------------------------------------------------
-- Transactional outbox
-- ---------------------------------------------------------------------------------------------
CREATE TABLE eventhub.outbox_event (
  id               uuid PRIMARY KEY,  -- the domain event_id; consumers dedupe on it
  organization_id  uuid,
  event_type       text NOT NULL,
  schema_version   integer NOT NULL CHECK (schema_version > 0),
  aggregate_type   text NOT NULL,
  aggregate_id     uuid NOT NULL,
  actor_type       text NOT NULL CHECK (actor_type IN ('user', 'system', 'platform_support')),
  actor_id         uuid,
  correlation_id   text NOT NULL,
  causation_id     text,
  payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at      timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  available_at     timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  last_error       text
);
CREATE INDEX outbox_event_pending_idx ON eventhub.outbox_event (available_at) WHERE status = 'pending';

ALTER TABLE eventhub.outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.outbox_event FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_event_app_insert ON eventhub.outbox_event FOR INSERT TO eventhub_app
  WITH CHECK (organization_id = eventhub.current_organization_id());
-- The relay is a platform process that forwards events for all tenants; it may read and update
-- delivery state only. Workers that act on events must revalidate aggregate ownership.
CREATE POLICY outbox_event_worker ON eventhub.outbox_event FOR ALL TO eventhub_worker
  USING (true) WITH CHECK (true);
GRANT INSERT ON eventhub.outbox_event TO eventhub_app;
GRANT SELECT ON eventhub.outbox_event TO eventhub_worker;
GRANT UPDATE (status, attempts, available_at, published_at, last_error) ON eventhub.outbox_event TO eventhub_worker;

-- Consumer-side deduplication ledger.
CREATE TABLE eventhub.processed_event (
  consumer      text NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  event_id      uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
GRANT SELECT, INSERT ON eventhub.processed_event TO eventhub_worker;

-- ---------------------------------------------------------------------------------------------
-- Idempotency keys (scoped to the authenticated actor)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE eventhub.idempotency_key (
  actor_id         uuid NOT NULL,
  scope            text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 300),
  key              text NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{8,255}$'),
  request_hash     text NOT NULL CHECK (char_length(request_hash) = 64),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (actor_id, scope, key)
);
CREATE INDEX idempotency_key_expiry_idx ON eventhub.idempotency_key (expires_at);

ALTER TABLE eventhub.idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventhub.idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_key_actor ON eventhub.idempotency_key FOR ALL TO eventhub_app
  USING (actor_id = eventhub.current_user_id())
  WITH CHECK (actor_id = eventhub.current_user_id());
GRANT SELECT, INSERT ON eventhub.idempotency_key TO eventhub_app;
GRANT UPDATE (request_hash, response_status, response_body, created_at, expires_at)
  ON eventhub.idempotency_key TO eventhub_app;
