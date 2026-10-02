-- =====================================================================
-- Shared synced_status column for compliance_records
-- Date: 2026-10-02
--
-- Holds the source-defined status reported by the sync source
-- (Manual / RPA / API), shown in the Synced Compliance Records section.
-- Separate from the authoritative calculated_status so it never alters
-- dashboard/report status logic.
-- =====================================================================

BEGIN;

ALTER TABLE compliance_records
    ADD COLUMN IF NOT EXISTS synced_status VARCHAR(100);

COMMIT;
