BEGIN;

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS last_invitation_sent TIMESTAMPTZ;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS invitation_count INTEGER NOT NULL DEFAULT 0;

UPDATE public.user_profiles AS profile
SET last_login = auth_user.last_sign_in_at
FROM auth.users AS auth_user
WHERE profile.auth_user_id = auth_user.id
  AND profile.last_login IS NULL
  AND auth_user.last_sign_in_at IS NOT NULL;

UPDATE public.user_profiles AS profile
SET last_invitation_sent = COALESCE(auth_user.confirmation_sent_at, auth_user.invited_at)
FROM auth.users AS auth_user
WHERE profile.auth_user_id = auth_user.id
  AND profile.last_invitation_sent IS NULL
  AND (auth_user.confirmation_sent_at IS NOT NULL OR auth_user.invited_at IS NOT NULL);

UPDATE public.user_profiles
SET invitation_count = 1
WHERE invitation_count = 0
  AND last_invitation_sent IS NOT NULL;

ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS user_profiles_status_check;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_status_check
    CHECK (status IN ('Active', 'Inactive', 'Disabled'));

UPDATE public.user_profiles
SET status = 'Disabled', updated_at = NOW()
WHERE status = 'Inactive';

COMMIT;