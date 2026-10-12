-- Synthetic isolated acceptance tests only. Never run this file in production.
BEGIN;

INSERT INTO public.contractors(id, company_name, nj_brc_number, brc_name_control, federal_tax_id, active)
VALUES
    (101, 'Alpha & Builders', '1234567890', 'ALPH', '12-3456789', TRUE),
    (102, 'Beta Builders', '0000000102', 'BETA', '001234567', TRUE),
    (103, 'Gamma Builders', '9999999103', 'GAMM', '98 7654321', TRUE),
    (104, 'Delta Builders', '1111111104', 'DELT', '111223333', TRUE),
    (105, 'Epsilon Contracting LLC', '1111111105', 'EPSI', '44-5556666', TRUE);

INSERT INTO public.compliance_records(
    contractor_id, compliance_type_id, registration_number, effective_date,
    expiration_date, verified_date, verified_by, verification_source, active, is_current
)
SELECT 101, id, 'OLD-101', DATE '2024-01-01', NULL, DATE '2024-01-01', 'Fixture', 'Manual', TRUE, TRUE
FROM public.compliance_types WHERE compliance_name = 'NJ BRC';
INSERT INTO public.compliance_records(
    contractor_id, compliance_type_id, registration_number, effective_date,
    expiration_date, verified_date, verified_by, verification_source, active, is_current
)
SELECT 102, id, 'OLD-102', DATE '2024-02-01', NULL, DATE '2024-02-01', 'Fixture', 'Manual', TRUE, TRUE
FROM public.compliance_types WHERE compliance_name = 'NJ BRC';

CREATE TEMP TABLE nj_brc_test_state (
    key TEXT PRIMARY KEY,
    request_id UUID,
    review_id INTEGER,
    record_id INTEGER
);
GRANT SELECT, INSERT, UPDATE, DELETE ON nj_brc_test_state TO authenticated, service_role;

-- Creation is user-authorized and returns only masked identifiers.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', TRUE);
DO $$
BEGIN
    BEGIN
        PERFORM * FROM public.create_nj_brc_search_request(101, '123456789000');
        RAISE EXCEPTION 'User without Contractors manage created an NJ BRC request';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE
    created RECORD;
    duplicate RECORD;
BEGIN
    SELECT * INTO created
    FROM public.create_nj_brc_search_request(101, '123456789000');
    IF created.status <> 'pending' OR created.existing OR created.federal_tax_id_masked <> '***-**-6789'
       OR created.taxpayer_id_submission_masked <> '********9000' THEN
        RAISE EXCEPTION 'Creation response did not return the expected masked snapshot';
    END IF;
    INSERT INTO nj_brc_test_state(key, request_id) VALUES ('approval', created.id);

    SELECT * INTO duplicate
    FROM public.create_nj_brc_search_request(101, '123456789000');
    IF NOT duplicate.existing OR duplicate.id <> created.id THEN
        RAISE EXCEPTION 'Duplicate active request was not returned idempotently';
    END IF;

    BEGIN
        PERFORM * FROM public.create_nj_brc_search_request(104, '111223333001');
        RAISE EXCEPTION 'Mismatched taxpayer ID submission was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        PERFORM * FROM public.claim_nj_brc_search_request('00000000-0000-0000-0000-000000000001');
        RAISE EXCEPTION 'Authenticated user could claim a service request';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        SELECT * FROM public.nj_brc_search_requests;
        RAISE EXCEPTION 'Authenticated user could directly read restricted request snapshots';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;

-- Master edits cannot mutate queued snapshots. An active duplicate still
-- refers to the original request snapshot rather than silently replacing it.
RESET ROLE;
UPDATE public.contractors SET nj_brc_number = 'A123456789' WHERE id = 104;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
BEGIN
    BEGIN
        PERFORM * FROM public.create_nj_brc_search_request(104, '111223333000');
        RAISE EXCEPTION 'Non-numeric Business Entity ID was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
RESET ROLE;
UPDATE public.contractors SET nj_brc_number = '1111111104', brc_name_control = 'A LP' WHERE id = 104;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
BEGIN
    BEGIN
        PERFORM * FROM public.create_nj_brc_search_request(104, '111223333000');
        RAISE EXCEPTION 'Name Control containing spaces was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
RESET ROLE;
UPDATE public.contractors SET brc_name_control = 'DELT', federal_tax_id = 'abc-111223333' WHERE id = 104;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
BEGIN
    BEGIN
        PERFORM * FROM public.create_nj_brc_search_request(104, '111223333000');
        RAISE EXCEPTION 'FEIN containing letters was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
RESET ROLE;
UPDATE public.contractors SET company_name = 'Renamed Alpha', nj_brc_number = 'BE-101-EDITED'
WHERE id = 101;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE
    duplicate RECORD;
    request_key UUID;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'approval';
    SELECT * INTO duplicate FROM public.create_nj_brc_search_request(101, '123456789000');
    IF NOT duplicate.existing OR duplicate.id <> request_key
       OR duplicate.company_name <> 'Alpha & Builders' OR duplicate.nj_brc_number <> '1234567890' THEN
        RAISE EXCEPTION 'Active duplicate after master edit was not surfaced';
    END IF;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE request public.nj_brc_search_requests%ROWTYPE;
BEGIN
    SELECT r.* INTO request FROM public.nj_brc_search_requests r
    JOIN nj_brc_test_state s ON s.request_id = r.id
    WHERE s.key = 'approval';
    IF request.company_name <> 'Alpha & Builders' OR request.nj_brc_number <> '1234567890'
       OR request.federal_tax_id <> '12-3456789'
       OR request.taxpayer_id_submission <> '123456789000' THEN
        RAISE EXCEPTION 'Queued contractor snapshot changed with master edit';
    END IF;
END;
$$;
RESET ROLE;
UPDATE public.contractors SET company_name = 'Alpha & Builders', nj_brc_number = '1234567890' WHERE id = 101;

-- The shared queue guard is NJ BRC-specific; service-side PWC writes still
-- pass through unchanged.
SET LOCAL ROLE service_role;
DO $$
DECLARE
    queue_id INTEGER;
BEGIN
    INSERT INTO public.compliance_sync_review_queue(
        contractor_id, compliance_name, proposed_registration_number, status, sync_source
    )
    VALUES (101, 'NJ PWC', 'PWC-REG-101', 'pending', 'RPA')
    RETURNING id INTO queue_id;
    UPDATE public.compliance_sync_review_queue SET status = 'approved' WHERE id = queue_id;
    DELETE FROM public.compliance_sync_review_queue WHERE id = queue_id;
    IF EXISTS (SELECT 1 FROM public.compliance_sync_review_queue WHERE id = queue_id) THEN
        RAISE EXCEPTION 'Existing PWC queue insert/update/delete behavior changed';
    END IF;
END;
$$;

-- Claiming is atomic, owned, idempotent for the same instance, and never
-- automatically reclaims an uncertain abandoned claim.
DO $$
DECLARE
    claimed RECORD;
    repeated RECORD;
    other RECORD;
    request_key UUID;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'approval';
    SELECT * INTO claimed FROM public.claim_nj_brc_search_request('10000000-0000-0000-0000-000000000001');
    IF claimed.id <> request_key OR claimed.status <> 'claimed'
       OR claimed.taxpayer_id_submission <> '123456789000' THEN
        RAISE EXCEPTION 'Worker did not atomically claim expected request snapshot';
    END IF;
    SELECT * INTO repeated FROM public.claim_nj_brc_search_request('10000000-0000-0000-0000-000000000001');
    IF repeated.id <> request_key OR repeated.status <> 'claimed' THEN
        RAISE EXCEPTION 'Same worker claim was not idempotent';
    END IF;
    SELECT * INTO other FROM public.claim_nj_brc_search_request('10000000-0000-0000-0000-000000000002');
    IF other.id IS NOT NULL THEN RAISE EXCEPTION 'Second worker claimed an owned request'; END IF;

    BEGIN
        PERFORM public.set_nj_brc_search_request_state(
            request_key, '10000000-0000-0000-0000-000000000002', 'processing');
        RAISE EXCEPTION 'Non-owning worker changed request state';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    PERFORM public.set_nj_brc_search_request_state(
        request_key, '10000000-0000-0000-0000-000000000001', 'processing');
    BEGIN
        UPDATE public.nj_brc_search_requests SET federal_tax_id = '000000000'
        WHERE id = request_key;
        RAISE EXCEPTION 'Immutable request snapshot was changed';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE public.nj_brc_search_requests SET claimed_at = now() - interval '2 days'
    WHERE id = request_key;
    SELECT * INTO other FROM public.claim_nj_brc_search_request('10000000-0000-0000-0000-000000000003');
    IF other.id IS NOT NULL THEN RAISE EXCEPTION 'Abandoned claim was automatically retried'; END IF;
END;
$$;

DO $$
DECLARE
    request_key UUID;
    report RECORD;
    repeated RECORD;
    queue_row public.compliance_sync_review_queue%ROWTYPE;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'approval';
    SELECT * INTO report FROM public.report_nj_brc_search_result(
        request_key, '10000000-0000-0000-0000-000000000001', 'successful_certificate',
        jsonb_build_object(
            'taxpayer_name', 'Alpha and Builders, L.L.C.',
            'trade_name', 'Alpha',
            'address', '100 Main Street',
            'certificate_number', 'CERT-101',
            'effective_date', '2025-03-04',
            'date_of_issuance', '2025-03-05',
            'office_use_only', 'Office copy',
            'source_url', 'https://www1.state.nj.us/TYTR_BRC/',
            'verified_at', '2026-10-09T10:00:00Z',
            'match_rationale', 'Name and identifier were reviewed; submitted 123456789000 and FEIN 12 3456789.',
            'discrepancy_warnings', jsonb_build_array('Trade name differs'),
            'federal_tax_id', '12-3456789',
            'taxpayer_id_submission', '123456789000',
            'raw_html', '<html>secret</html>'
        ), NULL
    );
    IF report.status <> 'review_required' OR report.review_queue_id IS NULL OR report.idempotent THEN
        RAISE EXCEPTION 'Successful result did not create pending Review Required item';
    END IF;
    INSERT INTO nj_brc_test_state(key, request_id, review_id)
    VALUES ('approval-review', request_key, report.review_queue_id);
    SELECT * INTO repeated FROM public.report_nj_brc_search_result(
        request_key, '10000000-0000-0000-0000-000000000001', 'successful_certificate',
        jsonb_build_object('certificate_number', 'CERT-101'), NULL
    );
    IF NOT repeated.idempotent OR repeated.review_queue_id <> report.review_queue_id THEN
        RAISE EXCEPTION 'Repeated result created duplicate review evidence';
    END IF;
    SELECT * INTO queue_row FROM public.compliance_sync_review_queue WHERE id = report.review_queue_id;
    IF queue_row.status <> 'pending' OR queue_row.proposed_registration_number <> 'CERT-101'
       OR queue_row.proposed_expiration_date IS NOT NULL
       OR queue_row.federal_tax_id_masked <> '***-**-6789'
       OR queue_row.taxpayer_id_submission_masked <> '********9000'
       OR queue_row.brc_evidence ? 'federal_tax_id'
       OR queue_row.brc_evidence ? 'taxpayer_id_submission'
       OR queue_row.brc_evidence ? 'raw_html'
       OR position('123456789000' IN queue_row.brc_evidence::TEXT) > 0
       OR position('12-3456789' IN queue_row.brc_evidence::TEXT) > 0
       OR position('12 3456789' IN queue_row.brc_evidence::TEXT) > 0 THEN
        RAISE EXCEPTION 'Review evidence was not sanitized/masked or was not non-expiring';
    END IF;
    BEGIN
        UPDATE public.compliance_sync_review_queue SET status = 'approved'
        WHERE id = report.review_queue_id;
        RAISE EXCEPTION 'Service role bypassed transactional NJ BRC approval';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE
    affected INTEGER;
    duplicate RECORD;
BEGIN
    UPDATE public.compliance_sync_review_queue SET status = 'approved'
    WHERE id = (SELECT review_id FROM nj_brc_test_state WHERE key = 'approval-review');
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Direct authenticated NJ BRC approval was not blocked'; END IF;
    SELECT * INTO duplicate FROM public.create_nj_brc_search_request(101, '123456789000');
    IF NOT duplicate.existing OR duplicate.status <> 'review_required'
       OR duplicate.id <> (SELECT request_id FROM nj_brc_test_state WHERE key = 'approval') THEN
        RAISE EXCEPTION 'Review Required request was not treated as active duplicate';
    END IF;
END;
$$;
RESET ROLE;

-- Approval requires Compliance Sync manage and atomically appends history.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', TRUE);
DO $$
DECLARE request_key UUID;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'approval';
    BEGIN
        PERFORM public.approve_nj_brc_search_request(request_key, 'Not authorized');
        RAISE EXCEPTION 'Unauthorized NJ BRC approval was accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;

RESET ROLE;
UPDATE public.compliance_types SET requires_expiration = TRUE
WHERE compliance_name = 'NJ BRC';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE
    request_key UUID;
    record_key INTEGER;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'approval';
    BEGIN
        PERFORM public.approve_nj_brc_search_request(request_key, 'Must not approve expiring type.');
        RAISE EXCEPTION 'NJ BRC approval ignored an incorrect expiration registry flag';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.compliance_records
        WHERE contractor_id = 101 AND registration_number = 'OLD-101' AND active AND is_current
    ) THEN RAISE EXCEPTION 'Failed registry precheck changed authoritative records'; END IF;
END;
$$;
RESET ROLE;
UPDATE public.compliance_types SET requires_expiration = FALSE
WHERE compliance_name = 'NJ BRC';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE
    request_key UUID;
    record_key INTEGER;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'approval';
    record_key := public.approve_nj_brc_search_request(request_key, 'Manual review passed.');
    UPDATE nj_brc_test_state SET record_id = record_key WHERE key = 'approval-review';
    BEGIN
        PERFORM public.approve_nj_brc_search_request(request_key, 'Repeat');
        RAISE EXCEPTION 'Repeated approval was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE
    request_key UUID;
    record_key INTEGER;
BEGIN
    SELECT s.request_id, s.record_id INTO request_key, record_key
    FROM nj_brc_test_state s WHERE s.key = 'approval-review';
    IF NOT EXISTS (
        SELECT 1 FROM public.compliance_records
        WHERE id = record_key AND registration_number = 'CERT-101'
          AND effective_date = DATE '2025-03-04' AND expiration_date IS NULL
          AND verification_source = 'NJ BRC Website'
          AND active AND is_current
    ) THEN RAISE EXCEPTION 'Approval did not store the certificate as a non-expiring current record'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.compliance_records
        WHERE contractor_id = 101 AND registration_number = 'OLD-101'
          AND NOT active AND NOT is_current
    ) THEN RAISE EXCEPTION 'Approval did not preserve/archive prior authoritative history'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.contractors WHERE id = 101
          AND company_name = 'Alpha & Builders' AND nj_brc_number = '1234567890'
          AND brc_name_control = 'ALPH' AND federal_tax_id = '12-3456789'
    ) THEN RAISE EXCEPTION 'Approval modified contractor master identifiers'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.compliance_sync_review_queue q
        JOIN public.nj_brc_search_requests r ON r.id = q.nj_brc_request_id
        WHERE r.id = request_key AND q.status = 'approved' AND r.status = 'completed'
    ) THEN RAISE EXCEPTION 'Review queue/request decision was not committed'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.administration_audit_log
        WHERE object_type = 'nj_brc_search_requests' AND object_id = request_key::TEXT
          AND action = 'APPROVE'
    ) THEN RAISE EXCEPTION 'Approval audit entry missing'; END IF;
END;
$$;
RESET ROLE;

-- Rejection preserves current records, and No Match leaves them untouched.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE created RECORD;
BEGIN
    SELECT * INTO created FROM public.create_nj_brc_search_request(102, '001234567000');
    INSERT INTO nj_brc_test_state(key, request_id) VALUES ('reject', created.id);
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE
    created RECORD;
    request_key UUID;
    result RECORD;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'reject';
    SELECT * INTO created FROM public.claim_nj_brc_search_request('20000000-0000-0000-0000-000000000001');
    IF created.id <> request_key OR created.taxpayer_id_submission <> '001234567000' THEN
        RAISE EXCEPTION 'Unable to claim rejection fixture or leading zeros were lost';
    END IF;
    PERFORM public.set_nj_brc_search_request_state(
        request_key, '20000000-0000-0000-0000-000000000001', 'processing');
    SELECT * INTO result FROM public.report_nj_brc_search_result(
        request_key, '20000000-0000-0000-0000-000000000001', 'successful_certificate',
        jsonb_build_object(
            'taxpayer_name', 'Beta-Builders, Inc.', 'certificate_number', 'CERT-102',
            'effective_date', '2025-04-05', 'source_url', 'https://www1.state.nj.us/TYTR_BRC/',
            'match_rationale', 'Returned taxpayer name matches contractor identity.'
        ), NULL
    );
    UPDATE nj_brc_test_state SET review_id = result.review_queue_id WHERE key = 'reject';

    SELECT * INTO created FROM public.claim_nj_brc_search_request('30000000-0000-0000-0000-000000000001');
    IF created.id IS NOT NULL THEN RAISE EXCEPTION 'Claim unexpectedly reused a completed request'; END IF;
    -- A second contractor can be processed by a new instance only after it
    -- has a pending request; request 102 is still review_required here.
END;
$$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE request_key UUID;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'reject';
    IF NOT public.reject_nj_brc_search_request(request_key, 'Evidence did not match our records.') THEN
        RAISE EXCEPTION 'Rejection did not return success';
    END IF;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE request_key UUID;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'reject';
    IF NOT EXISTS (
        SELECT 1 FROM public.compliance_records
        WHERE contractor_id = 102 AND registration_number = 'OLD-102' AND active AND is_current
    ) THEN RAISE EXCEPTION 'Rejection modified existing authoritative record'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.compliance_sync_review_queue
        WHERE nj_brc_request_id = request_key AND status = 'rejected'
          AND rejection_reason = 'Evidence did not match our records.'
    ) THEN RAISE EXCEPTION 'Rejection reason was not preserved'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.administration_audit_log
        WHERE object_type = 'nj_brc_search_requests' AND object_id = request_key::TEXT
          AND action = 'REJECT'
    ) THEN RAISE EXCEPTION 'Rejection audit entry missing'; END IF;
END;
$$;
RESET ROLE;

-- No Match is source-classified and cannot deactivate authoritative data.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE created RECORD;
BEGIN
    SELECT * INTO created FROM public.create_nj_brc_search_request(103, '987654321000');
    INSERT INTO nj_brc_test_state(key, request_id) VALUES ('no-match', created.id);
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE created RECORD;
DECLARE request_key UUID;
DECLARE result RECORD;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'no-match';
    SELECT * INTO created FROM public.claim_nj_brc_search_request('40000000-0000-0000-0000-000000000001');
    IF created.id <> request_key THEN RAISE EXCEPTION 'Unable to claim No Match fixture'; END IF;
    PERFORM public.report_nj_brc_search_result(
        request_key, '40000000-0000-0000-0000-000000000001', 'no_match',
        jsonb_build_object('source_url', 'https://www1.state.nj.us/TYTR_BRC/'), NULL
    );
    IF NOT EXISTS (SELECT 1 FROM public.nj_brc_search_requests WHERE id = request_key AND status = 'no_match')
        THEN RAISE EXCEPTION 'No Match was not explicitly classified'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.compliance_sync_exceptions WHERE contractor_id = 103 AND result_status = 'No Match Found')
        THEN RAISE EXCEPTION 'No Match exception/evidence missing'; END IF;

    SELECT * INTO created FROM public.claim_nj_brc_search_request('50000000-0000-0000-0000-000000000001');
    IF created.id IS NOT NULL THEN RAISE EXCEPTION 'Terminal No Match request was incorrectly reclaimed'; END IF;
END;
$$;
RESET ROLE;

-- A caller cannot turn a wrong-company certificate into a successful review
-- item by labeling its terminal result successful_certificate.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE created RECORD;
BEGIN
    SELECT * INTO created FROM public.create_nj_brc_search_request(105, '445556666000');
    INSERT INTO nj_brc_test_state(key, request_id) VALUES ('wrong-identity', created.id);
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE
    request_key UUID;
    claimed RECORD;
    result RECORD;
    repeated RECORD;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'wrong-identity';
    SELECT * INTO claimed FROM public.claim_nj_brc_search_request('80000000-0000-0000-0000-000000000001');
    IF claimed.id <> request_key THEN RAISE EXCEPTION 'Unable to claim wrong-identity fixture'; END IF;
    PERFORM public.set_nj_brc_search_request_state(
        request_key, '80000000-0000-0000-0000-000000000001', 'processing');
    SELECT * INTO result FROM public.report_nj_brc_search_result(
        request_key, '80000000-0000-0000-0000-000000000001', 'successful_certificate',
        jsonb_build_object(
            'taxpayer_name', 'Unrelated Heavy Construction Corporation',
            'certificate_number', 'WRONG-CERT-105',
            'effective_date', '2025-05-06',
            'source_url', 'https://www1.state.nj.us/TYTR_BRC/',
            'match_rationale', 'A service client incorrectly labeled this unrelated identity successful.'
        ), NULL
    );
    IF result.status <> 'identity_mismatch' OR result.review_queue_id IS NOT NULL THEN
        RAISE EXCEPTION 'Wrong-company successful result was not downgraded to identity_mismatch';
    END IF;
    SELECT * INTO repeated FROM public.report_nj_brc_search_result(
        request_key, '80000000-0000-0000-0000-000000000001', 'successful_certificate',
        '{}'::jsonb, NULL
    );
    IF NOT repeated.idempotent OR repeated.status <> 'identity_mismatch' THEN
        RAISE EXCEPTION 'Wrong-company identity downgrade was not idempotent';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.nj_brc_search_requests
        WHERE id = request_key AND result_type = 'identity_mismatch' AND review_queue_id IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.compliance_sync_exceptions
        WHERE contractor_id = 105 AND result_status = 'Identity Mismatch')
       OR EXISTS (SELECT 1 FROM public.compliance_sync_review_queue
        WHERE contractor_id = 105 AND compliance_name = 'NJ BRC') THEN
        RAISE EXCEPTION 'Wrong-company evidence created an approvable review item';
    END IF;
END;
$$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', TRUE);
DO $$
DECLARE request_key UUID;
BEGIN
    SELECT request_id INTO request_key FROM nj_brc_test_state WHERE key = 'wrong-identity';
    BEGIN
        PERFORM public.approve_nj_brc_search_request(request_key, 'Approve wrong identity');
        RAISE EXCEPTION 'Wrong-company identity result was approved';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
RESET ROLE;

-- Human verification and website-error health states coexist with PWC health.
SET LOCAL ROLE service_role;
DO $$
BEGIN
    IF NOT public.report_compliance_worker(jsonb_build_object(
        'worker_key', 'nj-brc', 'instance_id', '60000000-0000-0000-0000-000000000001',
        'started_at', now(), 'sequence', 1, 'lifecycle', 'human_verification_required',
        'browser_connected', TRUE, 'current_request_key', '80000000-0000-0000-0000-000000000001',
        'event', 'human_verification_required', 'request_key', '80000000-0000-0000-0000-000000000001',
        'message', 'Manual verification required'
    )) THEN RAISE EXCEPTION 'NJ BRC human-verification health report rejected'; END IF;
    IF NOT public.report_compliance_worker(jsonb_build_object(
        'worker_key', 'nj-brc', 'instance_id', '60000000-0000-0000-0000-000000000001',
        'started_at', (SELECT started_at FROM public.compliance_sync_workers WHERE worker_key = 'nj-brc'),
        'sequence', 2, 'lifecycle', 'website_error', 'browser_connected', TRUE,
        'current_request_key', '80000000-0000-0000-0000-000000000001',
        'event', 'website_error', 'message', 'Synthetic site error'
    )) THEN RAISE EXCEPTION 'NJ BRC website-error health report rejected'; END IF;
    UPDATE public.compliance_sync_workers
    SET test_id = '70000000-0000-0000-0000-000000000001',
        test_requested_at = now(), test_acknowledged_at = NULL
    WHERE worker_key = 'nj-brc';
    IF NOT public.report_compliance_worker(jsonb_build_object(
        'worker_key', 'nj-brc', 'instance_id', '60000000-0000-0000-0000-000000000001',
        'started_at', (SELECT started_at FROM public.compliance_sync_workers WHERE worker_key = 'nj-brc'),
        'sequence', 3, 'lifecycle', 'human_verification_required',
        'browser_connected', TRUE, 'last_poll_at', now(),
        'current_request_key', '80000000-0000-0000-0000-000000000001',
        'test_id', '70000000-0000-0000-0000-000000000001',
        'event', 'test', 'message', 'Synthetic diagnostic while challenge is pending'
    )) THEN RAISE EXCEPTION 'NJ BRC human-verification diagnostic report rejected'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.compliance_sync_workers
        WHERE worker_key = 'nj-brc' AND test_acknowledged_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Fresh browser-connected human-verification diagnostic was not acknowledged';
    END IF;
    UPDATE public.compliance_sync_workers
    SET test_requested_at = now(), test_acknowledged_at = NULL
    WHERE worker_key = 'nj-brc';
    IF NOT public.report_compliance_worker(jsonb_build_object(
        'worker_key', 'nj-brc', 'instance_id', '60000000-0000-0000-0000-000000000001',
        'started_at', (SELECT started_at FROM public.compliance_sync_workers WHERE worker_key = 'nj-brc'),
        'sequence', 4, 'lifecycle', 'human_verification_required',
        'browser_connected', TRUE, 'last_poll_at', now() - interval '3 minutes',
        'current_request_key', '80000000-0000-0000-0000-000000000001',
        'test_id', '70000000-0000-0000-0000-000000000001',
        'event', 'test', 'message', 'Stale queue poll'
    )) THEN RAISE EXCEPTION 'Stale-poll diagnostic report was not accepted as telemetry'; END IF;
    IF EXISTS (SELECT 1 FROM public.compliance_sync_workers
        WHERE worker_key = 'nj-brc' AND test_acknowledged_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Stale-poll human-verification diagnostic was incorrectly acknowledged';
    END IF;
    IF NOT public.report_compliance_worker(jsonb_build_object(
        'worker_key', 'nj-pwc', 'instance_id', '60000000-0000-0000-0000-000000000002',
        'started_at', now(), 'sequence', 1, 'lifecycle', 'busy',
        'browser_connected', TRUE, 'event', 'search', 'request_id', '44',
        'result_status', 'No Match Found', 'message', 'Existing PWC report'
    )) THEN RAISE EXCEPTION 'Existing NJ PWC health report regressed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.compliance_sync_workers WHERE worker_key = 'nj-brc' AND lifecycle = 'human_verification_required')
       OR NOT EXISTS (SELECT 1 FROM public.compliance_sync_workers WHERE worker_key = 'nj-pwc' AND lifecycle = 'busy') THEN
        RAISE EXCEPTION 'Worker Health lifecycle was not retained';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.compliance_sync_workers
        WHERE worker_key = 'nj-brc'
          AND last_error = 'Synthetic site error'
          AND current_request_key = '80000000-0000-0000-0000-000000000001')
       OR NOT EXISTS (SELECT 1 FROM public.compliance_sync_worker_events
        WHERE worker_key = 'nj-brc' AND event = 'human_verification_required'
          AND request_key = '80000000-0000-0000-0000-000000000001') THEN
        RAISE EXCEPTION 'NJ BRC worker UUID health diagnostics were not retained';
    END IF;
END;
$$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
    BEGIN
        PERFORM public.create_nj_brc_search_request(101, '123456789000');
        RAISE EXCEPTION 'Anonymous request creation was allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM public.approve_nj_brc_search_request('00000000-0000-0000-0000-000000000001', NULL);
        RAISE EXCEPTION 'Anonymous approval was allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
RESET ROLE;
ROLLBACK;
