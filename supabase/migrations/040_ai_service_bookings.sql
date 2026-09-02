-- ============================================================
-- 040_ai_service_bookings.sql — AI booking capture (receptionist flow)
--
-- Adds the `service_bookings` table that the AI auto-reply bot writes
-- to when it detects a complete service booking in a customer
-- conversation, plus the owner-alert phone on `ai_configs`.
--
-- Design notes
--   - Fields mirror the receptionist flow's lead sheet: who (name +
--     phone snapshot from the contact), where (location), what
--     (service_type + unit_count), when (preferred_datetime as free
--     text — customers say "Saturday morning", not ISO timestamps).
--   - One conversation produces at most one pending booking: the
--     capture path updates the existing pending row instead of
--     inserting a duplicate on every bot turn.
--   - `status` follows the booking lifecycle the inbox acts on.
--   - `booking_alert_phone` on `ai_configs` is where the instant
--     "new lead" WhatsApp notification goes (the business owner's
--     personal number). Null = capture silently, no alert.
--
-- RLS — dashboard-class, mirroring 029: any member (viewer+) may read
-- bookings (they appear in the account's pipeline of leads), admin+
-- may change them. The capture path runs under the service-role
-- client (a webhook has no auth.uid()), so RLS guards dashboard
-- reads, not the engine.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS service_bookings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id       uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id            uuid REFERENCES contacts(id) ON DELETE SET NULL,
  customer_name         text NOT NULL,
  customer_phone        text,             -- snapshot of the contact's phone at capture time
  location              text,             -- city / street / suburb the job is at
  service_type          text NOT NULL,    -- what the customer wants done
  preferred_datetime    text NOT NULL,    -- free-text slot ("Saturday morning", "2026-09-05 10:00")
  unit_count            integer NOT NULL DEFAULT 1 CHECK (unit_count BETWEEN 1 AND 500),
  status                text NOT NULL DEFAULT 'pending_confirmation'
                          CHECK (status IN ('pending_confirmation', 'confirmed', 'completed', 'cancelled')),
  source_message_id     text,             -- Meta message id that completed the capture (traceability)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_bookings_account_recent
  ON service_bookings (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_bookings_conversation
  ON service_bookings (conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE service_bookings ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the bookings —
-- they are business data, like contacts.
DROP POLICY IF EXISTS service_bookings_select ON service_bookings;
CREATE POLICY service_bookings_select ON service_bookings FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only from the dashboard. The
-- service-role capture path bypasses RLS by design.
DROP POLICY IF EXISTS service_bookings_insert ON service_bookings;
CREATE POLICY service_bookings_insert ON service_bookings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS service_bookings_update ON service_bookings;
CREATE POLICY service_bookings_update ON service_bookings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS service_bookings_delete ON service_bookings;
CREATE POLICY service_bookings_delete ON service_bookings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Keep updated_at fresh on every write.
CREATE OR REPLACE FUNCTION public.update_service_bookings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS service_bookings_updated_at ON service_bookings;
CREATE TRIGGER service_bookings_updated_at
  BEFORE UPDATE ON service_bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_service_bookings_updated_at();

-- ============================================================
-- Owner-alert phone for the booking capture flow.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS booking_alert_phone text;