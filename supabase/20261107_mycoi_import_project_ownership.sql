-- Apply prospectively only. No historical assignments or finalized runs are rewritten.
BEGIN;

ALTER FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID,JSONB)
    RENAME TO mycoi_apply_import_transaction;
REVOKE ALL ON FUNCTION public.mycoi_apply_import_transaction(UUID,INTEGER,TEXT,JSONB,JSONB,UUID,JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- Extend the existing transaction without changing COMPLETE's authoritative pair rules.
CREATE FUNCTION public.mycoi_apply_import(
    p_run UUID, p_revision INTEGER, p_token TEXT, p_plan JSONB, p_audits JSONB, p_actor UUID,
    p_snapshot JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    result JSONB;
    history_id INTEGER;
    vendor JSONB;
    contractor INTEGER;
    pair RECORD;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mycoi_manual_import'));
    PERFORM pg_advisory_xact_lock(hashtext('contractor_project_ownership'));
    result := mycoi_apply_import_transaction(p_run,p_revision,p_token,p_plan,p_audits,p_actor,p_snapshot);
    IF p_snapshot IS NOT NULL THEN RETURN result; END IF;
    SELECT import_history_id INTO STRICT history_id FROM mycoi_import_runs WHERE id=p_run;
    IF history_id IS NULL THEN
        RAISE EXCEPTION 'Imported project ownership requires import history';
    END IF;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import',history_id::text,true);
    FOR vendor IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
        -- Approved Adds have their real contractor ID in the persisted mapping, not the input plan.
        SELECT contractor_id INTO STRICT contractor FROM mycoi_vendor_mappings
            WHERE active AND vendor_name_key=vendor->>'key';
        FOR pair IN SELECT DISTINCT (d->>'projectId')::integer project_id
            FROM jsonb_array_elements(vendor->'divisions') d
        LOOP
            PERFORM set_project_assignment_source(contractor,pair.project_id,'MYCOI',true);
        END LOOP;
    END LOOP;
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID,JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID,JSONB) TO service_role;

COMMIT;
