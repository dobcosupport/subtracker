-- Add NY PWC and NY BRC registration numbers to contractors.
-- Nullable text columns to match existing NJ fields.

BEGIN;

ALTER TABLE contractors
    ADD COLUMN IF NOT EXISTS ny_pwc_number TEXT,
    ADD COLUMN IF NOT EXISTS ny_brc_number TEXT;

COMMIT;
