BEGIN;

ALTER TABLE public.app_roles
    ADD COLUMN IF NOT EXISTS description TEXT;

COMMIT;
