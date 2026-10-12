BEGIN;

ALTER TABLE public.contractors
    ADD COLUMN federal_tax_id TEXT NULL;

COMMIT;
