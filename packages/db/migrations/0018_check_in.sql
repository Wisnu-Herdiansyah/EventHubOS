-- Event-day check-in (ADR-0028). Expand-only.
--
-- A confirmed registration can be checked in once (and undone, for mistakes at the door). Who did
-- it is kept for accountability; the audit log has the full history.

ALTER TABLE eventhub.registration
  ADD COLUMN checked_in_at timestamptz,
  ADD COLUMN checked_in_by uuid REFERENCES eventhub.app_user (id),
  ADD CONSTRAINT registration_check_in_pair CHECK ((checked_in_at IS NULL) = (checked_in_by IS NULL));

-- Door lists: confirmed attendees of one event, by name.
CREATE INDEX registration_event_name_idx
  ON eventhub.registration (organization_id, event_id, lower(name)) WHERE status = 'confirmed';

GRANT UPDATE (checked_in_at, checked_in_by) ON eventhub.registration TO eventhub_app;
