-- Active/Inactive User Management support
--
-- Uses the existing `user_profiles.status` column.
-- Supported values for the active/inactive workflow: 'Active' / 'Inactive'.
-- (The legacy 'Disabled' value is normalized to 'Inactive' below.)
--
-- Deactivating a user NEVER deletes the auth account, profile, login history,
-- audit history, or any records created by the user (contractor updates,
-- project updates, compliance changes, follow-ups, document uploads, approvals).
-- Inactive users cannot log in: the API session check rejects non-Active
-- profiles and the Supabase auth account is banned while inactive.

-- Track when and by whom a user was deactivated.
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS deactivated_by VARCHAR(200);

-- Normalize legacy 'Disabled' accounts to 'Inactive'.
UPDATE public.user_profiles
SET status = 'Inactive',
    deactivated_at = COALESCE(deactivated_at, updated_at),
    updated_at = NOW()
WHERE status = 'Disabled';

-- Backfill deactivation date for already-inactive users.
UPDATE public.user_profiles
SET deactivated_at = updated_at
WHERE status = 'Inactive'
  AND deactivated_at IS NULL;

-- Index to support Active/Inactive user list filtering.
CREATE INDEX IF NOT EXISTS idx_user_profiles_status ON public.user_profiles (status);
