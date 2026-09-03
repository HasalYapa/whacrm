-- ============================================================
-- 042_contact_avatars.sql — manual contact profile photos
--
-- Meta's Cloud API does not expose a customer's WhatsApp profile
-- photo (the legacy WABA endpoint was removed), so avatars are
-- uploaded manually by account members:
--   - `contacts.avatar_url` — public URL of the uploaded image.
--   - `contact-avatars` storage bucket — public read, member write,
--     account-scoped paths (`account-<account_id>/...`) matching the
--     convention migration 020 established for flow-media and 023
--     reused for chat-media.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS avatar_url text;

-- ============================================================
-- 1. contact-avatars storage bucket (2 MB, images only)
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contact-avatars',
  'contact-avatars',
  TRUE,
  2097152, -- 2 MB (same cap as the profile avatars bucket, migration 008)
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 2. Storage RLS — public reads, account-scoped member writes
--
-- Same predicate shape as migrations 020/023: the path's first
-- segment must be `account-<account_id>` for an account the caller
-- belongs to (agent+ to write, mirroring the contacts_update RLS).
-- ============================================================
DROP POLICY IF EXISTS "Contact avatars are publicly readable" ON storage.objects;
CREATE POLICY "Contact avatars are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'contact-avatars');

DROP POLICY IF EXISTS "Members can upload contact avatars" ON storage.objects;
CREATE POLICY "Members can upload contact avatars"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'contact-avatars'
    AND is_account_member(
      (substring((storage.foldername(name))[1] from 9))::uuid,
      'agent'
    )
  );

DROP POLICY IF EXISTS "Members can update contact avatars" ON storage.objects;
CREATE POLICY "Members can update contact avatars"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'contact-avatars'
    AND is_account_member(
      (substring((storage.foldername(name))[1] from 9))::uuid,
      'agent'
    )
  );

DROP POLICY IF EXISTS "Members can delete contact avatars" ON storage.objects;
CREATE POLICY "Members can delete contact avatars"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'contact-avatars'
    AND is_account_member(
      (substring((storage.foldername(name))[1] from 9))::uuid,
      'agent'
    )
  );
