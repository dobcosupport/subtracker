-- Add Material Vendor Only flag to contractors.
-- Identifies companies that supply materials only (no labor/services).

BEGIN;

ALTER TABLE contractors
    ADD COLUMN IF NOT EXISTS material_vendor_only BOOLEAN NOT NULL DEFAULT false;

COMMIT;
