-- Require two-step verification for Owners and Admins (ADR-0024). Expand-only.
--
-- When on, an Owner or Admin without active two-step verification may read the organization's
-- profile (to learn why access is blocked) and nothing else; the check runs in the shared
-- organization access guard on every tenant request. Other roles are unaffected.

ALTER TABLE eventhub.organization
  ADD COLUMN require_mfa_for_admins boolean NOT NULL DEFAULT false;
GRANT UPDATE (require_mfa_for_admins) ON eventhub.organization TO eventhub_app;
