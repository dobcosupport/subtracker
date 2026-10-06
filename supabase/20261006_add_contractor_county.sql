-- =====================================================================
-- Contractor Master — add County
-- Date: 2026-10-06
--
-- The real NJ Public Works Power BI report returns County in addition to
-- Address / City / State / ZIP / Certificate Number. The Contractor
-- Master previously had no County field.
--
-- Non-destructive: ADD COLUMN IF NOT EXISTS only.
--   * No data changes. No deletes. No updates. No drops.
--   * SQL Server compatible: plain nullable column, no DEFAULT
--     constraint, no CHECK constraint, no index (not queried/filtered).
-- =====================================================================

BEGIN;

ALTER TABLE public.contractors
    ADD COLUMN IF NOT EXISTS county VARCHAR(100);

COMMIT;
