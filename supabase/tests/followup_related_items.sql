-- Synthetic isolated fixture only; never run this file against production.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM contractor_followups WHERE id = 5
        AND compliance_record_id = 100 AND compliance_type_id IS NULL
        AND insurance_item_key IS NULL AND status = 'Open') THEN
        RAISE EXCEPTION 'Migration rewrote a legacy follow-up';
    END IF;
    IF (SELECT jsonb_agg(to_jsonb(p) ORDER BY policyname) FROM pg_policies p
        WHERE schemaname = 'public' AND tablename = 'contractor_followups')
        IS DISTINCT FROM (SELECT policies FROM before_related_items) THEN
        RAISE EXCEPTION 'Follow-up policies changed';
    END IF;
    IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger
        WHERE tgname = 'audit_followup_changes')
        IS DISTINCT FROM (SELECT audit_trigger FROM before_related_items) THEN
        RAISE EXCEPTION 'Audit trigger changed';
    END IF;
END;
$$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

INSERT INTO contractor_followups (contractor_id, followup_date, followup_method, subject, status)
VALUES (8, '2026-10-08', 'Email', 'General', 'Open');
INSERT INTO contractor_followups (contractor_id, compliance_type_id, followup_date, followup_method, subject, status)
SELECT 8, id, '2026-10-08', 'Email', compliance_name, 'Open' FROM compliance_types WHERE active;
INSERT INTO contractor_followups (contractor_id, insurance_item_key, followup_date, followup_method, subject, status)
SELECT 8, key, '2026-10-08', 'Email', key, 'Open'
FROM unnest(ARRAY['certificate_of_insurance','general_liability','workers_compensation']) AS key;
INSERT INTO contractor_followups (contractor_id, compliance_record_id, followup_date, followup_method, subject, status)
VALUES (8, 100, '2026-10-08', 'Email', 'Old client record-only', 'Open');

DO $$
DECLARE affected INTEGER;
BEGIN
    IF (SELECT count(*) FROM contractor_followups WHERE compliance_type_id IS NOT NULL AND compliance_record_id IS NULL) <> 6 THEN
        RAISE EXCEPTION 'Type-only follow-ups were not preserved';
    END IF;
    IF (SELECT count(*) FROM contractor_followups WHERE insurance_item_key IS NOT NULL AND compliance_record_id IS NULL AND compliance_type_id IS NULL) <> 3 THEN
        RAISE EXCEPTION 'Insurance categories were not preserved';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM contractor_followups WHERE subject = 'Old client record-only' AND compliance_type_id = 6 AND compliance_record_id = 100) THEN
        RAISE EXCEPTION 'Old-client type derivation failed';
    END IF;
    UPDATE contractor_followups SET compliance_type_id = 6, compliance_record_id = 101 WHERE subject = 'General';
    UPDATE contractor_followups SET compliance_record_id = 100 WHERE subject = 'General';
    UPDATE contractor_followups SET compliance_record_id = NULL WHERE subject = 'General';
    IF NOT EXISTS (SELECT 1 FROM contractor_followups WHERE subject = 'General' AND compliance_type_id = 6 AND compliance_record_id IS NULL) THEN
        RAISE EXCEPTION 'No specific record did not retain type';
    END IF;
    UPDATE contractor_followups SET compliance_type_id = NULL, insurance_item_key = NULL, compliance_record_id = NULL WHERE subject = 'General';
    UPDATE contractor_followups SET insurance_item_key = 'general_liability' WHERE subject = 'General';
    UPDATE contractor_followups SET insurance_item_key = NULL WHERE subject = 'General';
    IF NOT EXISTS (SELECT 1 FROM contractor_followups WHERE subject = 'General' AND compliance_type_id IS NULL AND insurance_item_key IS NULL AND compliance_record_id IS NULL) THEN
        RAISE EXCEPTION 'General did not clear all relationships';
    END IF;
    UPDATE contractor_followups SET status = 'Waiting Response' WHERE id = 5;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'Editor update blocked'; END IF;
    UPDATE contractor_followups SET status = 'Closed' WHERE id = 5;
    IF EXISTS (SELECT 1 FROM contractor_followups WHERE id = 5 AND status IN ('Open','Waiting Response')) THEN
        RAISE EXCEPTION 'Closed remains active';
    END IF;
    UPDATE contractor_followups SET status = 'Open' WHERE id = 5;
    UPDATE contractor_followups SET status = 'Resolved' WHERE id = 5;
    IF NOT EXISTS (SELECT 1 FROM contractor_followups WHERE id = 5 AND status = 'Resolved' AND compliance_record_id = 100 AND compliance_type_id IS NULL) THEN
        RAISE EXCEPTION 'Legacy status edits altered history or relationships';
    END IF;
    BEGIN
        UPDATE contractor_followups SET compliance_type_id = 7, compliance_record_id = 100 WHERE subject = 'General';
        RAISE EXCEPTION 'Mismatched type accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE contractor_followups SET compliance_record_id = 200 WHERE subject = 'General';
        RAISE EXCEPTION 'Wrong contractor accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE contractor_followups SET insurance_item_key = 'general_liability', compliance_type_id = 6 WHERE subject = 'General';
        RAISE EXCEPTION 'Two related categories accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE contractor_followups SET insurance_item_key = 'general_liability', compliance_record_id = 100 WHERE subject = 'General';
        RAISE EXCEPTION 'Insurance record link accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE contractor_followups SET insurance_item_key = 'invalid' WHERE subject = 'General';
        RAISE EXCEPTION 'Invalid insurance key accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE contractor_followups SET compliance_record_id = 99999 WHERE subject = 'General';
        RAISE EXCEPTION 'Missing record accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE contractor_followups SET compliance_type_id = 99999 WHERE subject = 'General';
        RAISE EXCEPTION 'Missing type accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END;
$$;

RESET ROLE;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM administration_audit_log WHERE object_type = 'contractor_followups'
        AND action = 'UPDATE' AND details->'changed_fields' ? 'compliance_type_id')
       OR NOT EXISTS (SELECT 1 FROM administration_audit_log WHERE object_type = 'contractor_followups'
        AND action = 'UPDATE' AND details->'changed_fields' ? 'insurance_item_key')
       OR NOT EXISTS (SELECT 1 FROM administration_audit_log WHERE object_type = 'contractor_followups'
        AND action = 'INSERT' AND details->'changed_fields' ? 'insurance_item_key') THEN
        RAISE EXCEPTION 'Existing audit trigger did not record new relationship fields';
    END IF;
    BEGIN
        DELETE FROM compliance_types WHERE id = 6;
        RAISE EXCEPTION 'Referenced type deletion accepted';
    EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL;
    END;
END;
$$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
DO $$
DECLARE affected INTEGER;
BEGIN
    UPDATE contractor_followups SET status = 'Open' WHERE id = 5;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Non-editor update allowed'; END IF;
END;
$$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
DO $$
DECLARE affected INTEGER;
BEGIN
    UPDATE contractor_followups SET status = 'Open' WHERE id = 5;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Inactive editor update allowed'; END IF;
END;
$$;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
DO $$
DECLARE affected INTEGER;
BEGIN
    UPDATE contractor_followups SET status = 'Open' WHERE id = 5;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Anonymous update allowed'; END IF;
END;
$$;
ROLLBACK;
