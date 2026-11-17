-- Organizer notes on registrations (ADR-0067). Expand-only.
--
-- Staff can keep a short private note on any entry ("VIP", "needs step-free access"). The note
-- is for staff only: it is shown in the attendee list, the export and at check-in, and never to
-- the person or on the public site. Who last changed it, and when, is kept with it.

ALTER TABLE eventhub.registration
  ADD COLUMN staff_note text,
  ADD COLUMN staff_note_updated_at timestamptz,
  ADD COLUMN staff_note_updated_by uuid REFERENCES eventhub.app_user (id),
  -- A cleared note is NULL, never an empty string; 500 characters at most.
  ADD CONSTRAINT registration_staff_note_length
    CHECK (staff_note IS NULL OR char_length(staff_note) BETWEEN 1 AND 500),
  ADD CONSTRAINT registration_staff_note_change_pair
    CHECK ((staff_note_updated_at IS NULL) = (staff_note_updated_by IS NULL));
GRANT UPDATE (staff_note, staff_note_updated_at, staff_note_updated_by)
  ON eventhub.registration TO eventhub_app;
