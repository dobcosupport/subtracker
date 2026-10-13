-- =====================================================================
-- NJ PWC auto-approval + daily registry sync: schema
-- Date: 2026-10-14
--
-- Non-destructive: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- Apply BEFORE 20261014_nj_pwc_registry_sync_functions.sql.
-- Requires the existing core, Compliance Sync, RPA, Test Mode, search
-- request, and NJ PWC schema-alignment migrations. Run this entire file
-- as one transaction, then run the functions file; do not run section 8
-- in isolation. No view/dependent-object drops are needed.
--
-- compliance_sync_settings.mode (NJ PWC row) remains the master switch:
--   review_required -> every result is routed to the Review Queue
--   auto_approve    -> user-selected imports and daily exact matches are
--                      approved server-side; low-confidence results are
--                      always routed to review.
-- compliance_sync_settings.test_mode turns the daily sync into a dry run.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Compliance records: registry verification state (never deactivates
--    a record on its own; expiration is represented by a new version
--    carrying registry_status = 'Expired - Not Found in Registry').
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_records
    ADD COLUMN IF NOT EXISTS registry_status VARCHAR(40),
    ADD COLUMN IF NOT EXISTS registry_status_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_registry_sync_at TIMESTAMPTZ;

ALTER TABLE public.compliance_records
    DROP CONSTRAINT IF EXISTS compliance_records_registry_status_check;
ALTER TABLE public.compliance_records
    ADD CONSTRAINT compliance_records_registry_status_check
    CHECK (registry_status IS NULL OR registry_status IN (
        'OK', 'Investigation Required', 'Expired - Not Found in Registry'
    ));

-- ---------------------------------------------------------------------
-- 2. Settings: configurable consecutive-failure expiration threshold.
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_settings
    ADD COLUMN IF NOT EXISTS failure_expire_threshold INTEGER NOT NULL DEFAULT 3;

ALTER TABLE public.compliance_sync_settings
    DROP CONSTRAINT IF EXISTS compliance_sync_settings_failure_expire_threshold_check;
ALTER TABLE public.compliance_sync_settings
    ADD CONSTRAINT compliance_sync_settings_failure_expire_threshold_check
    CHECK (failure_expire_threshold BETWEEN 1 AND 30);

-- ---------------------------------------------------------------------
-- 3. Sync runs: run type + run date (one daily run per date / mode).
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS run_type VARCHAR(30),
    ADD COLUMN IF NOT EXISTS run_date DATE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_sync_runs_nj_pwc_daily
    ON public.compliance_sync_runs (run_type, run_date, is_test)
    WHERE run_type = 'nj_pwc_daily';

-- ---------------------------------------------------------------------
-- 4. Search requests: contractor binding, origin, priority, import state.
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_search_requests
    ADD COLUMN IF NOT EXISTS contractor_id INTEGER REFERENCES public.contractors(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sync_run_id INTEGER REFERENCES public.compliance_sync_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS search_variation VARCHAR(40),
    ADD COLUMN IF NOT EXISTS sync_outcome VARCHAR(40),
    ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS imported_by VARCHAR(200),
    ADD COLUMN IF NOT EXISTS imported_certificate_number VARCHAR(100),
    ADD COLUMN IF NOT EXISTS import_review_queue_id INTEGER;

ALTER TABLE public.compliance_sync_search_requests
    DROP CONSTRAINT IF EXISTS compliance_sync_search_requests_origin_check;
ALTER TABLE public.compliance_sync_search_requests
    ADD CONSTRAINT compliance_sync_search_requests_origin_check
    CHECK (origin IN ('user', 'daily_sync', 'exception_retry'));

-- User searches (0) are served before exception retries (10) and the
-- daily batch (20).
CREATE INDEX IF NOT EXISTS idx_compliance_sync_search_requests_pending_priority
    ON public.compliance_sync_search_requests (compliance_name, priority, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_compliance_sync_search_requests_run
    ON public.compliance_sync_search_requests (sync_run_id, status)
    WHERE sync_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_compliance_sync_search_requests_contractor
    ON public.compliance_sync_search_requests (contractor_id, status)
    WHERE contractor_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 5. Review queue: why an item needs review + originating search.
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS review_reason VARCHAR(60),
    ADD COLUMN IF NOT EXISTS search_request_id INTEGER
        REFERENCES public.compliance_sync_search_requests(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- 6. Per-contractor registry sync state. Live (is_test = FALSE) and
--    dry-run (is_test = TRUE) progressions are tracked independently so
--    Test Mode never advances live failure counts.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nj_pwc_sync_state (
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    state VARCHAR(30) NOT NULL DEFAULT 'OK'
        CHECK (state IN ('OK', 'Investigation Required', 'Review Required', 'Expired')),
    consecutive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
    last_reason VARCHAR(40),
    last_attempt_at TIMESTAMPTZ,
    last_successful_sync_at TIMESTAMPTZ,
    last_search_request_id INTEGER REFERENCES public.compliance_sync_search_requests(id) ON DELETE SET NULL,
    last_run_id INTEGER REFERENCES public.compliance_sync_runs(id) ON DELETE SET NULL,
    pending_expiration_run_id INTEGER REFERENCES public.compliance_sync_runs(id) ON DELETE SET NULL,
    expired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contractor_id, is_test)
);

-- Test Mode (shadow) classification: the most recent action the automation
-- WOULD have taken for this contractor. Only set on is_test rows; drives the
-- "Would Auto Approve" / "Would Expire" dashboard metrics.
ALTER TABLE public.nj_pwc_sync_state
    ADD COLUMN IF NOT EXISTS dry_run_action VARCHAR(40),
    ADD COLUMN IF NOT EXISTS dry_run_action_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'nj_pwc_sync_state_dry_run_action_check'
          AND conrelid = 'public.nj_pwc_sync_state'::regclass
    ) THEN
        ALTER TABLE public.nj_pwc_sync_state
            ADD CONSTRAINT nj_pwc_sync_state_dry_run_action_check CHECK (
                dry_run_action IS NULL OR (is_test AND dry_run_action IN (
                    'would_auto_approve', 'would_request_review', 'would_expire', 'would_propose_expiration'
                ))
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_nj_pwc_sync_state_pending_expiration
    ON public.nj_pwc_sync_state (pending_expiration_run_id)
    WHERE pending_expiration_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nj_pwc_sync_state_dry_run_action
    ON public.nj_pwc_sync_state (dry_run_action)
    WHERE is_test AND dry_run_action IS NOT NULL;

-- ---------------------------------------------------------------------
-- 7. Daily exception report.
--    kind = failure        -> counts toward expiration
--    kind = review         -> low confidence, routed to review, not counted
--    kind = infrastructure -> registry/worker outage, never counted
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nj_pwc_sync_exceptions (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    reason VARCHAR(40) NOT NULL CHECK (reason IN (
        'No Match Found', 'Multiple Matches', 'Name Mismatch',
        'Expired Registration', 'Certificate Changed', 'Registry Anomaly',
        'Registry Unavailable', 'Invalid Search'
    )),
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('failure', 'review', 'infrastructure')),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    consecutive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
    occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
    expired_by_sync BOOLEAN NOT NULL DEFAULT FALSE,
    first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_run_id INTEGER REFERENCES public.compliance_sync_runs(id) ON DELETE SET NULL,
    last_search_request_id INTEGER REFERENCES public.compliance_sync_search_requests(id) ON DELETE SET NULL,
    review_queue_id INTEGER REFERENCES public.compliance_sync_review_queue(id) ON DELETE SET NULL,
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    resolved_by VARCHAR(200),
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nj_pwc_sync_exceptions_open
    ON public.nj_pwc_sync_exceptions (contractor_id, reason, is_test)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_nj_pwc_sync_exceptions_status
    ON public.nj_pwc_sync_exceptions (status, last_attempt_at DESC);

-- Read access for authenticated users (Compliance Sync page); all writes
-- go through service-role routes and SECURITY DEFINER functions.
ALTER TABLE public.nj_pwc_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nj_pwc_sync_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nj_pwc_sync_state_select ON public.nj_pwc_sync_state;
CREATE POLICY nj_pwc_sync_state_select ON public.nj_pwc_sync_state
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS nj_pwc_sync_exceptions_select ON public.nj_pwc_sync_exceptions;
CREATE POLICY nj_pwc_sync_exceptions_select ON public.nj_pwc_sync_exceptions
    FOR SELECT TO authenticated USING (TRUE);

-- ---------------------------------------------------------------------
-- 8. Contractor compliance status: a registry-confirmed expiration is
--    Expired regardless of the stored expiration date.
--
--    Preserve existing column order for both the 10-column deployed view
--    and the 12-column repository view. Correct the legacy
--    complaince_record_id spelling with ALTER VIEW, not CREATE OR REPLACE.
--    No DROP: dependent objects, owner, and existing grants are retained.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_view REGCLASS := to_regclass('public.contractor_compliance_status');
    v_columns TEXT;
    v_unknown TEXT;
    v_select TEXT;
BEGIN
    IF v_view IS NOT NULL THEN
        IF (SELECT relkind FROM pg_class WHERE oid = v_view) <> 'v' THEN
            RAISE EXCEPTION 'public.contractor_compliance_status exists but is not an ordinary view.';
        END IF;

        IF EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = v_view AND attname = 'complaince_record_id'
              AND attnum > 0 AND NOT attisdropped
        ) THEN
            IF EXISTS (
                SELECT 1 FROM pg_attribute
                WHERE attrelid = v_view AND attname = 'compliance_record_id'
                  AND attnum > 0 AND NOT attisdropped
            ) THEN
                RAISE EXCEPTION 'contractor_compliance_status contains both complaince_record_id and compliance_record_id.'
                    USING HINT = 'Inspect the view definition before migrating; do not drop dependent objects.';
            END IF;
            ALTER VIEW public.contractor_compliance_status
                RENAME COLUMN complaince_record_id TO compliance_record_id;
        END IF;

        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
        INTO v_unknown
        FROM pg_attribute
        WHERE attrelid = v_view AND attnum > 0 AND NOT attisdropped
          AND attname NOT IN (
              'contractor_id', 'company_name', 'contractor_active',
              'compliance_active', 'compliance_current', 'compliance_record_id',
              'compliance_type_id', 'compliance_name', 'registration_number',
              'expiration_date', 'days_remaining', 'calculated_status'
          );
        IF v_unknown IS NOT NULL THEN
            RAISE EXCEPTION 'Unsupported contractor_compliance_status columns: %', v_unknown
                USING HINT = 'Inspect the view definition before migrating; existing columns must not be removed.';
        END IF;

        SELECT string_agg(format('status.%I', attname), ', ' ORDER BY attnum)
        INTO v_columns
        FROM pg_attribute
        WHERE attrelid = v_view AND attnum > 0 AND NOT attisdropped;
    ELSE
        v_columns := 'status.contractor_id, status.company_name, status.contractor_active, '
            || 'status.compliance_record_id, status.compliance_type_id, status.compliance_name, '
            || 'status.registration_number, status.expiration_date, status.days_remaining, status.calculated_status';
    END IF;

    v_select := $view$
SELECT
    c.id AS contractor_id,
    c.company_name,
    c.active AS contractor_active,
    cr.active AS compliance_active,
    cr.is_current AS compliance_current,
    CASE WHEN ct.id IS NULL THEN NULL ELSE cr.id END AS compliance_record_id,
    ct.id AS compliance_type_id,
    ct.compliance_name,
    cr.registration_number,
    cr.expiration_date,
    CASE
        WHEN cr.id IS NULL THEN NULL
        WHEN cr.expiration_date IS NULL THEN NULL
        ELSE (cr.expiration_date - CURRENT_DATE)::INTEGER
    END AS days_remaining,
    CASE
        WHEN cr.id IS NULL THEN 'Missing Information'
        WHEN ct.requires_expiration = TRUE AND cr.expiration_date IS NULL THEN 'Missing Information'
        WHEN ct.compliance_name IN ('NJ PWC', 'NY PWC')
            AND NULLIF(TRIM(cr.registration_number), '') IS NULL THEN 'Missing Information'
        WHEN cr.registry_status = 'Expired - Not Found in Registry' THEN 'Expired'
        WHEN cr.expiration_date <= CURRENT_DATE THEN 'Expired'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 1 AND 30 THEN '30 Day'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 31 AND 60 THEN '60 Day'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 61 AND 90 THEN '90 Day'
        WHEN cr.expiration_date IS NULL AND ct.requires_expiration = FALSE THEN 'Active'
        WHEN (cr.expiration_date - CURRENT_DATE) > 90 THEN 'Active'
        ELSE 'Active'
    END AS calculated_status
FROM public.contractors c
LEFT JOIN public.compliance_records cr
    ON cr.contractor_id = c.id
   AND cr.active = TRUE
   AND cr.is_current = TRUE
LEFT JOIN public.compliance_types ct
    ON ct.id = cr.compliance_type_id
   AND ct.active = TRUE
WHERE c.active = TRUE
$view$;

    EXECUTE 'CREATE OR REPLACE VIEW public.contractor_compliance_status WITH (security_invoker = true) AS SELECT '
        || v_columns || ' FROM (' || v_select || ') AS status';
END $$;

REVOKE ALL ON public.contractor_compliance_status FROM anon;
GRANT SELECT ON public.contractor_compliance_status TO authenticated;

COMMIT;
