BEGIN;

-- Policy/division composite FKs require one owning vendor mapping.
-- Contractor-wide uniqueness would merge aliases that cannot share those links.
DROP INDEX public.mycoi_policy_current_identity;
CREATE UNIQUE INDEX mycoi_policy_current_identity
    ON public.mycoi_policies(vendor_mapping_id, policy_line_key, policy_number_key, expiration_date)
    WHERE active AND is_current AND policy_number_key IS NOT NULL AND expiration_date IS NOT NULL;
COMMENT ON INDEX public.mycoi_policy_current_identity IS
    'Exact current policy identity within its vendor mapping; aliases retain their own source/project associations.';

CREATE TABLE public.mycoi_import_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 250),
    created_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_imported_at TIMESTAMPTZ,
    revision INTEGER NOT NULL DEFAULT 1,
    source_rows JSONB NOT NULL CHECK (jsonb_typeof(source_rows) = 'array'),
    source_row_count INTEGER GENERATED ALWAYS AS (jsonb_array_length(source_rows)) STORED,
    decisions JSONB NOT NULL,
    imported_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
    imported_vendor_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
    imported_policy_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    metrics JSONB NOT NULL DEFAULT '{"rows":0,"vendors":0,"policies":0,"changes":0,"exceptions":0}'::jsonb,
    status TEXT NOT NULL DEFAULT 'Review' CHECK (status IN ('Review', 'Partial', 'Complete')),
    import_history_id INTEGER REFERENCES public.import_history(id) ON DELETE RESTRICT
);
CREATE INDEX mycoi_import_runs_created ON public.mycoi_import_runs(created_at DESC, id);
ALTER TABLE public.mycoi_import_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mycoi_import_runs FROM anon, authenticated, service_role;
GRANT SELECT ON public.mycoi_import_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mycoi_import_runs TO service_role;
CREATE POLICY mycoi_import_runs_select ON public.mycoi_import_runs FOR SELECT TO authenticated
    USING (public.user_has_module_permission('imports', 'view') AND public.user_has_module_permission('insurance', 'view'));
CREATE TRIGGER mycoi_import_runs_updated_at BEFORE UPDATE ON public.mycoi_import_runs
    FOR EACH ROW EXECUTE FUNCTION public.mycoi_touch_updated_at();

CREATE FUNCTION public.mycoi_import_reference() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH state AS (
        SELECT jsonb_build_object(
            'contractors', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM
                (SELECT id, company_name, active FROM contractors) c), '[]'::jsonb),
            'projects', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM
                (SELECT id, project_number, project_name FROM projects) p), '[]'::jsonb),
            'vendors', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM mycoi_vendor_mappings v), '[]'::jsonb),
            'divisions', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM mycoi_division_mappings d), '[]'::jsonb),
            'statuses', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM mycoi_contractor_divisions s), '[]'::jsonb),
            'policies', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mycoi_policies p), '[]'::jsonb),
            'links', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM mycoi_policy_divisions l), '[]'::jsonb)
        ) AS value
    )
    SELECT value || jsonb_build_object('token', md5(value::text)) FROM state;
$$;
REVOKE ALL ON FUNCTION public.mycoi_import_reference() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mycoi_import_reference() TO service_role;

-- The server validates/parses the source and builds this plan and actor audit payload.
-- This service-only transaction persists data, history, and those audit events together.
CREATE FUNCTION public.mycoi_apply_import(
    p_run UUID, p_revision INTEGER, p_token TEXT, p_plan JSONB, p_audits JSONB, p_actor UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    run mycoi_import_runs%ROWTYPE;
    vendor JSONB;
    division JSONB;
    policy JSONB;
    audit JSONB;
    v_id INTEGER;
    d_id INTEGER;
    s_id INTEGER;
    p_id INTEGER;
    old_id INTEGER;
    old_policy mycoi_policies%ROWTYPE;
    old_vendor mycoi_vendor_mappings%ROWTYPE;
    division_key TEXT;
    division_ids JSONB;
    imported JSONB;
    vendor_keys JSONB;
    policy_ids JSONB;
    changes INTEGER := 0;
    affected INTEGER;
    exceptions INTEGER;
    ignored INTEGER;
    total INTEGER;
    now_at TIMESTAMPTZ := now();
    source_reference TEXT;
    history_id INTEGER;
    final_metrics JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mycoi_manual_import'));
    SELECT * INTO STRICT run FROM mycoi_import_runs WHERE id = p_run FOR UPDATE;
    IF run.revision <> p_revision THEN RAISE EXCEPTION 'Review changed; reload the preview' USING ERRCODE = '40001'; END IF;
    IF (mycoi_import_reference()->>'token') IS DISTINCT FROM p_token THEN
        RAISE EXCEPTION 'Source mappings or insurance changed; refresh preview before importing' USING ERRCODE = '40001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM user_profiles u WHERE auth_user_id = p_actor AND status = 'Active'
          AND (system_administrator OR NOT EXISTS (
            SELECT 1 FROM (VALUES ('imports','view'),('imports','add'),('imports','edit'),
                ('insurance','view'),('insurance','add'),('insurance','edit'),
                ('contractors','view'),('projects','view')) needed(module, action)
            WHERE NOT EXISTS (SELECT 1 FROM role_permissions r WHERE r.role = u.role AND r.module = needed.module
                AND CASE needed.action WHEN 'view' THEN r.can_view WHEN 'add' THEN r.can_add ELSE r.can_edit END)
          ))
    ) THEN RAISE EXCEPTION 'Import permissions are required' USING ERRCODE = '42501'; END IF;
    IF jsonb_typeof(p_plan) <> 'array' OR jsonb_typeof(p_audits) <> 'array' THEN
        RAISE EXCEPTION 'Invalid import plan';
    END IF;
    imported := run.imported_rows;
    vendor_keys := run.imported_vendor_keys;
    policy_ids := run.imported_policy_ids;
    total := jsonb_array_length(run.source_rows);
    history_id := run.import_history_id;
    IF history_id IS NULL THEN
        INSERT INTO import_history(file_name, imported_rows, successful_rows, failed_rows, notes)
        VALUES(run.file_name, total, 0, 0, 'myCOI manual import; detailed results in mycoi_import_runs')
        RETURNING id INTO history_id;
    END IF;
    source_reference := 'myCOI import ' || run.id::text || ' | ' || run.file_name;
    FOR vendor IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
        SELECT * INTO old_vendor FROM mycoi_vendor_mappings
            WHERE active AND vendor_name_key = vendor->>'key' FOR UPDATE;
        IF FOUND THEN
            IF old_vendor.contractor_id <> (vendor->>'contractorId')::integer THEN
                RAISE EXCEPTION 'Saved vendor mapping changed';
            END IF;
            v_id := old_vendor.id;
            IF (vendor->>'email' IS NOT NULL AND vendor->>'email' IS DISTINCT FROM old_vendor.vendor_email)
                OR (vendor->>'phone' IS NOT NULL AND vendor->>'phone' IS DISTINCT FROM old_vendor.vendor_phone) THEN changes := changes + 1; END IF;
            UPDATE mycoi_vendor_mappings SET vendor_email = COALESCE(vendor->>'email', vendor_email),
                vendor_phone = COALESCE(vendor->>'phone', vendor_phone), last_imported_at = now_at,
                import_reference = source_reference, import_history_id = history_id WHERE id = v_id;
        ELSE
            INSERT INTO mycoi_vendor_mappings(contractor_id, raw_vendor_name, vendor_email, vendor_phone,
                last_imported_at, import_reference, import_history_id)
            VALUES((vendor->>'contractorId')::integer, vendor->>'raw', vendor->>'email', vendor->>'phone',
                now_at, source_reference, history_id) RETURNING id INTO v_id;
            changes := changes + 1;
        END IF;
        division_ids := '{}'::jsonb;
        FOR division IN SELECT value FROM jsonb_array_elements(vendor->'divisions') LOOP
            SELECT id INTO d_id FROM mycoi_division_mappings
                WHERE active AND division_name_key = division->>'key' FOR UPDATE;
            IF NOT FOUND THEN
                INSERT INTO mycoi_division_mappings(raw_division_name, project_id)
                VALUES(division->>'raw', (division->>'projectId')::integer) RETURNING id INTO d_id;
                changes := changes + 1;
            ELSE
                IF EXISTS(SELECT 1 FROM mycoi_division_mappings WHERE id=d_id AND project_id IS NOT NULL
                    AND project_id <> (division->>'projectId')::integer) THEN RAISE EXCEPTION 'Saved project mapping changed'; END IF;
                UPDATE mycoi_division_mappings SET project_id=(division->>'projectId')::integer
                    WHERE id=d_id AND project_id IS NULL;
                GET DIAGNOSTICS affected = ROW_COUNT;
                changes := changes + affected;
            END IF;
            SELECT id INTO old_id FROM mycoi_contractor_divisions
                WHERE vendor_mapping_id=v_id AND division_mapping_id=d_id AND active AND is_current FOR UPDATE;
            IF old_id IS NOT NULL AND EXISTS(SELECT 1 FROM mycoi_contractor_divisions
                WHERE id=old_id AND compliance_status IS NOT DISTINCT FROM division->>'status') THEN
                s_id := old_id;
                UPDATE mycoi_contractor_divisions SET last_imported_at=now_at, import_reference=source_reference,
                    import_history_id=history_id WHERE id=s_id;
            ELSE
                UPDATE mycoi_contractor_divisions SET active=false,is_current=false WHERE id=old_id;
                INSERT INTO mycoi_contractor_divisions(vendor_mapping_id,division_mapping_id,compliance_status,
                    last_imported_at,import_reference,import_history_id)
                VALUES(v_id,d_id,division->>'status',now_at,source_reference,history_id) RETURNING id INTO s_id;
                INSERT INTO mycoi_policy_divisions(policy_id,contractor_division_id,vendor_mapping_id)
                    SELECT policy_id,s_id,vendor_mapping_id FROM mycoi_policy_divisions WHERE contractor_division_id=old_id
                    ON CONFLICT DO NOTHING;
                changes := changes + 1;
            END IF;
            division_ids := division_ids || jsonb_build_object(division->>'key',s_id);
        END LOOP;
        -- Only explicit same-number/line replacements supersede policies. Blank or missing data never deletes.
        FOR old_policy IN SELECT * FROM mycoi_policies
            WHERE vendor_mapping_id=v_id AND active AND is_current FOR UPDATE LOOP
            IF EXISTS(SELECT 1 FROM jsonb_array_elements(vendor->'policies') p
                WHERE lower(btrim(p->>'number'))=old_policy.policy_number_key
                  AND lower(regexp_replace(btrim(p->>'line'),'[[:space:]]+',' ','g'))=old_policy.policy_line_key)
              AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(vendor->'policies') p
                WHERE lower(btrim(p->>'number'))=old_policy.policy_number_key
                  AND lower(regexp_replace(btrim(p->>'line'),'[[:space:]]+',' ','g'))=old_policy.policy_line_key
                  AND (p->>'expiration')::date=old_policy.expiration_date) THEN
                UPDATE mycoi_policies SET active=false,is_current=false WHERE id=old_policy.id;
                changes := changes + 1;
            END IF;
        END LOOP;
        FOR policy IN SELECT value FROM jsonb_array_elements(vendor->'policies') LOOP
            SELECT * INTO old_policy FROM mycoi_policies
                WHERE vendor_mapping_id=v_id AND active AND is_current
                  AND policy_line_key=lower(regexp_replace(btrim(policy->>'line'),'[[:space:]]+',' ','g'))
                  AND policy_number_key=lower(btrim(policy->>'number'))
                  AND expiration_date=(policy->>'expiration')::date FOR UPDATE;
            IF FOUND AND old_policy.expired IS NOT DISTINCT FROM (policy->>'expired')::boolean THEN
                p_id := old_policy.id;
                UPDATE mycoi_policies SET last_imported_at=now_at,import_reference=source_reference,import_history_id=history_id WHERE id=p_id;
            ELSE
                UPDATE mycoi_policies SET active=false,is_current=false WHERE id=old_policy.id;
                INSERT INTO mycoi_policies(contractor_id,vendor_mapping_id,policy_line,policy_number,expiration_date,
                    expired,last_imported_at,import_reference,import_history_id)
                VALUES((vendor->>'contractorId')::integer,v_id,policy->>'line',policy->>'number',
                    (policy->>'expiration')::date,(policy->>'expired')::boolean,now_at,source_reference,history_id)
                RETURNING id INTO p_id;
                INSERT INTO mycoi_policy_divisions(policy_id,contractor_division_id,vendor_mapping_id)
                    SELECT p_id,contractor_division_id,v_id FROM mycoi_policy_divisions
                    WHERE policy_id=old_policy.id AND vendor_mapping_id=v_id ON CONFLICT DO NOTHING;
                changes := changes + 1;
            END IF;
            IF NOT policy_ids @> jsonb_build_array(p_id) THEN policy_ids := policy_ids || jsonb_build_array(p_id); END IF;
            FOR division_key IN SELECT jsonb_array_elements_text(policy->'divisions') LOOP
                SELECT vendor_mapping_id INTO affected FROM mycoi_policies WHERE id=p_id;
                s_id := (division_ids->>division_key)::integer;
                INSERT INTO mycoi_policy_divisions(policy_id,contractor_division_id,vendor_mapping_id)
                    VALUES(p_id,s_id,affected) ON CONFLICT DO NOTHING;
                GET DIAGNOSTICS affected = ROW_COUNT;
                changes := changes + affected;
            END LOOP;
        END LOOP;
        FOR affected IN SELECT value::integer FROM jsonb_array_elements_text(vendor->'rows') LOOP
            IF NOT imported @> jsonb_build_array(affected) THEN imported := imported || jsonb_build_array(affected); END IF;
        END LOOP;
        IF NOT vendor_keys @> jsonb_build_array(vendor->>'key') THEN vendor_keys := vendor_keys || jsonb_build_array(vendor->>'key'); END IF;
    END LOOP;
    SELECT count(*) INTO ignored FROM jsonb_array_elements(run.source_rows) r
        WHERE run.decisions->'ignored' @> jsonb_build_array((r->>'row')::integer);
    exceptions := total - jsonb_array_length(imported) - ignored;
    final_metrics := jsonb_build_object('rows',jsonb_array_length(imported),'vendors',jsonb_array_length(vendor_keys),
        'policies',jsonb_array_length(policy_ids),'changes',COALESCE((run.metrics->>'changes')::integer,0)+changes,'exceptions',exceptions);
    UPDATE mycoi_import_runs SET imported_rows=imported,imported_vendor_keys=vendor_keys,imported_policy_ids=policy_ids,
        metrics=final_metrics,status=CASE WHEN exceptions=0 THEN 'Complete' ELSE 'Partial' END,
        import_history_id=history_id,last_imported_at=now_at,revision=revision+1 WHERE id=p_run;
    UPDATE import_history SET successful_rows=jsonb_array_length(imported),failed_rows=exceptions,
        notes='myCOI | ' || final_metrics::text || ' | ignored=' || ignored || ' | run=' || p_run::text WHERE id=history_id;
    FOR audit IN SELECT value FROM jsonb_array_elements(p_audits) LOOP
        IF (audit->>'user_id')::uuid IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Audit actor mismatch'; END IF;
        INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
            VALUES(p_actor,audit->>'user_name',audit->>'user_email',audit->>'action','mycoi_import',p_run::text,
                run.file_name,COALESCE(audit->'details','{}'::jsonb) || jsonb_build_object('metrics',final_metrics,'batch_changes',changes));
    END LOOP;
    RETURN final_metrics;
END;
$$;
REVOKE ALL ON FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID) TO service_role;

COMMENT ON TABLE public.mycoi_import_runs IS
    'Manual myCOI staging, durable raw rows, review decisions, cumulative actual metrics and unresolved exceptions. No scheduled ingestion.';
COMMIT;
