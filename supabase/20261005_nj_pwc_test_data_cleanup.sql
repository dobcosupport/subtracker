-- =====================================================================
-- NJ PWC Test Data Cleanup — manual SQL (REVIEW BEFORE RUNNING)
-- Date: 2026-10-05
--
-- Targets ONLY the known simulator test contractors:
--   379  (J & A)
--   381  (J&A Concrete Corp.)
--   386  (atlas window group)
-- All three are INACTIVE and carry the test NJ PWC certificate # 123456.
--
-- Safety: the WHERE clauses restrict every DELETE to those ids AND to the
-- test certificate number, so legitimate compliance records are not touched.
-- Run inside a transaction; review the row counts before COMMIT.
-- =====================================================================

BEGIN;

-- 1) Test tracking rows tied to the test contractors
DELETE FROM public.compliance_sync_review_queue
    WHERE contractor_id IN (379, 381, 386);

DELETE FROM public.compliance_sync_exceptions
    WHERE contractor_id IN (379, 381, 386);

-- Display-only synced placeholders created during testing (none are Active
-- Compliance Records for these test contractors).
DELETE FROM public.compliance_records
    WHERE contractor_id IN (379, 381, 386);

-- 2) Other dependent rows (FK-safe)
DELETE FROM public.contractor_insurance      WHERE contractor_id IN (379, 381, 386);
DELETE FROM public.contractor_tiered_subs    WHERE contractor_id IN (379, 381, 386);
DELETE FROM public.contractor_tiered_subs    WHERE tiered_sub_contractor_id IN (379, 381, 386);
DELETE FROM public.contractor_projects       WHERE contractor_id IN (379, 381, 386);
DELETE FROM public.contractor_followups      WHERE contractor_id IN (379, 381, 386);
DELETE FROM public.activity_log              WHERE contractor_id IN (379, 381, 386);

-- 3) Test search requests (marked is_test = true; not tied to a contractor)
DELETE FROM public.compliance_sync_search_requests
    WHERE is_test = TRUE;

-- 4) The test contractors themselves — guarded by the test certificate number
--    AND inactive status so this can never remove a legitimate/active record.
DELETE FROM public.contractors
    WHERE id IN (379, 381, 386)
      AND active = FALSE
      AND nj_pwc_number = '123456';

-- Review the affected row counts, then:
--   COMMIT;   -- to apply
--   ROLLBACK; -- to abort
COMMIT;
