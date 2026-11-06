-- Organization settings (ORG-04, ADR-0012). Expand-only.
-- The billing contact is personal data: exposed only to roles with billing.read, and audited by
-- field name only. Data-retention configuration waits for plan entitlements and policy D9.

ALTER TABLE eventhub.organization
  ADD COLUMN billing_contact_name  text CHECK (billing_contact_name IS NULL OR char_length(billing_contact_name) BETWEEN 1 AND 200),
  ADD COLUMN billing_contact_email text CHECK (billing_contact_email IS NULL
                                              OR (billing_contact_email = lower(btrim(billing_contact_email))
                                                  AND char_length(billing_contact_email) BETWEEN 3 AND 320));

GRANT UPDATE (billing_contact_name, billing_contact_email) ON eventhub.organization TO eventhub_app;
