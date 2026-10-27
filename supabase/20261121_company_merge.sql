-- Company Merge: manually apply only after review. No merge or backfill is executed.
BEGIN;

ALTER TABLE public.role_permissions DROP CONSTRAINT role_permissions_module_check;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_module_check CHECK (module IN (
    'dashboard','contractors','compliance','insurance','followups','projects','tiered_subs',
    'reports','imports','documents','activity','users','roles','audit','settings','compliance_sync',
    'communications_summary','communications_content','communications_delivery','company_merge'));
ALTER TABLE public.role_permissions DROP CONSTRAINT role_permissions_check1;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_check1 CHECK (
    CASE WHEN module='company_merge' THEN can_view=can_manage AND NOT (can_add OR can_edit OR can_delete)
    ELSE can_manage=(can_add OR can_edit OR can_delete) END);
INSERT INTO public.role_permissions(role,module,can_view,can_manage,can_add,can_edit,can_delete)
    SELECT role,'company_merge',role='Administrator',role='Administrator',false,false,false FROM public.app_roles;

ALTER TABLE public.contractors DROP CONSTRAINT contractors_creation_source_check;
ALTER TABLE public.contractors ADD CONSTRAINT contractors_creation_source_check
    CHECK (creation_source IN ('MANUAL','MYCOI','PROCORE','MERGE'));
ALTER TABLE public.contractors ADD COLUMN merged_into_contractor_id INTEGER
    REFERENCES public.contractors(id) ON DELETE RESTRICT;
ALTER TABLE public.contractors ADD CONSTRAINT company_merge_archived
    CHECK (merged_into_contractor_id IS NULL OR (NOT active AND merged_into_contractor_id<>id));
CREATE INDEX contractors_merge_successor ON public.contractors(merged_into_contractor_id)
    WHERE merged_into_contractor_id IS NOT NULL;
INSERT INTO public.relationship_sources(source) VALUES ('MERGE');

CREATE TABLE public.company_merges (
    id UUID PRIMARY KEY,
    primary_id INTEGER NOT NULL UNIQUE REFERENCES public.contractors(id) ON DELETE RESTRICT,
    secondary_id INTEGER NOT NULL UNIQUE REFERENCES public.contractors(id) ON DELETE RESTRICT,
    successor_id INTEGER NOT NULL UNIQUE REFERENCES public.contractors(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    choices JSONB NOT NULL,
    compliance_choices JSONB NOT NULL,
    snapshot JSONB NOT NULL,
    result JSONB NOT NULL,
    CHECK(primary_id<>secondary_id AND successor_id<>primary_id AND successor_id<>secondary_id)
);
CREATE TABLE public.company_merge_lineage (
    merge_id UUID NOT NULL REFERENCES public.company_merges(id) ON DELETE RESTRICT,
    category TEXT NOT NULL,
    source_id TEXT NOT NULL,
    before_row JSONB NOT NULL,
    after_row JSONB,
    PRIMARY KEY(merge_id,category,source_id)
);
-- Internal, transaction-local capability. No API role can create or retain one.
CREATE TABLE public.company_merge_authorizations (
    backend_pid INTEGER NOT NULL,
    transaction_id BIGINT NOT NULL,
    merge_id UUID NOT NULL,
    PRIMARY KEY(backend_pid,transaction_id)
);
ALTER TABLE public.company_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_merge_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_merge_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_merges,public.company_merge_lineage,public.company_merge_authorizations
    FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.company_merges,public.company_merge_lineage TO service_role;

CREATE FUNCTION public.company_merge_authorized() RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT EXISTS(SELECT 1 FROM company_merge_authorizations
        WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current());
$$;
CREATE FUNCTION public.company_merge_actor(p_actor UUID) RETURNS public.user_profiles
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.user_profiles;
BEGIN
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active';
    IF actor.auth_user_id IS NULL OR NOT (coalesce(actor.system_administrator,false) OR EXISTS(
        SELECT 1 FROM role_permissions WHERE role=actor.role AND module='company_merge' AND can_manage)) THEN
        RAISE EXCEPTION 'Company Merge Manage permission required' USING ERRCODE='42501';
    END IF;
    RETURN actor;
END;
$$;
CREATE FUNCTION public.company_merge_fields() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT ARRAY['company_name','trade','contact_name','email','phone','address_1','address_2',
        'city','state','zip_code','county','federal_tax_id','sage_erp_id','external_id','legacy_id',
        'notes','material_vendor_only','brc_name_control','brc_name_control_is_manual',
        'nj_pwc_number','nj_brc_number','ny_pwc_number','ny_brc_number','active']::TEXT[];
$$;
CREATE FUNCTION public.company_merge_ancestors(p_contractor INTEGER) RETURNS INTEGER[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    WITH RECURSIVE ancestors(id,path) AS (
        SELECT p_contractor,ARRAY[p_contractor]
        UNION ALL
        SELECT p.id,a.path||p.id FROM ancestors a JOIN company_merges m ON m.successor_id=a.id
        CROSS JOIN LATERAL (VALUES(m.primary_id),(m.secondary_id)) p(id)
        WHERE NOT p.id=ANY(a.path)
    ) SELECT array_agg(DISTINCT id ORDER BY id) FROM ancestors;
$$;

-- Protect identities even when a stale import, old browser, or service RPC bypasses selectors.
CREATE FUNCTION public.company_merge_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item TEXT; target INTEGER;
BEGIN
    IF company_merge_authorized() THEN
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME IN('company_merges','company_merge_lineage') THEN
        RAISE EXCEPTION 'Company Merge history is permanent and read-only' USING ERRCODE='42501';
    END IF;
    IF TG_TABLE_NAME='contractors' THEN
        IF TG_OP='INSERT' THEN
            IF NEW.merged_into_contractor_id IS NOT NULL OR NEW.creation_source='MERGE' THEN
                RAISE EXCEPTION 'Merged identities can only be created by Company Merge' USING ERRCODE='23514';
            END IF;
        ELSE
            IF TG_OP='UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
                RAISE EXCEPTION 'Contractor identity is immutable' USING ERRCODE='23514';
            END IF;
            IF OLD.merged_into_contractor_id IS NOT NULL OR (TG_OP='UPDATE'
                AND NEW.merged_into_contractor_id IS DISTINCT FROM OLD.merged_into_contractor_id) THEN
                RAISE EXCEPTION 'Merged predecessor is permanently archived; use the successor company' USING ERRCODE='23514';
            END IF;
        END IF;
    ELSE
        FOREACH item IN ARRAY TG_ARGV LOOP
            IF TG_OP<>'DELETE' THEN
                target:=(to_jsonb(NEW)->>item)::integer;
                IF EXISTS(SELECT 1 FROM contractors WHERE id=target AND merged_into_contractor_id IS NOT NULL) THEN
                    RAISE EXCEPTION 'Merged predecessor cannot be used for new or changed % records',TG_TABLE_NAME USING ERRCODE='23514';
                END IF;
            END IF;
            IF TG_OP<>'INSERT' THEN
                target:=(to_jsonb(OLD)->>item)::integer;
                IF EXISTS(SELECT 1 FROM contractors WHERE id=target AND merged_into_contractor_id IS NOT NULL) THEN
                    RAISE EXCEPTION 'Merged predecessor history is read-only (%)',TG_TABLE_NAME USING ERRCODE='23514';
                END IF;
            END IF;
        END LOOP;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER company_merge_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON public.contractors
    FOR EACH ROW EXECUTE FUNCTION public.company_merge_guard();
CREATE TRIGGER company_merge_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.company_merges
    FOR EACH ROW EXECUTE FUNCTION public.company_merge_guard();
CREATE TRIGGER company_merge_lineage_guard BEFORE INSERT OR UPDATE OR DELETE ON public.company_merge_lineage
    FOR EACH ROW EXECUTE FUNCTION public.company_merge_guard();

DO $$
DECLARE entry RECORD;
BEGIN
    FOR entry IN SELECT c.relname,array_agg(DISTINCT att.attname::text ORDER BY att.attname::text) columns
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute att ON att.attrelid=c.oid AND att.attnum=ANY(k.conkey)
        WHERE k.contype='f' AND k.confrelid='public.contractors'::regclass
            AND n.nspname='public' AND c.relname NOT IN ('contractors','company_merges')
        GROUP BY c.relname
    LOOP
        EXECUTE format('CREATE TRIGGER company_merge_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I
            FOR EACH ROW EXECUTE FUNCTION public.company_merge_guard(%s)',entry.relname,
            (SELECT string_agg(quote_literal(v),',') FROM unnest(entry.columns) v));
    END LOOP;
END;
$$;

-- Keep the existing primary/normalization trigger; only its ownership-change check is narrowed.
DO $$
DECLARE definition TEXT; old_check TEXT := 'IF TG_OP = ''UPDATE'' AND NEW.contractor_id IS DISTINCT FROM OLD.contractor_id THEN';
BEGIN
    definition:=pg_get_functiondef('public.enforce_contractor_contact_primary()'::regprocedure);
    IF position(old_check IN definition)=0 THEN
        RAISE EXCEPTION 'Contact ownership trigger differs from the verified production definition; review migration';
    END IF;
    EXECUTE replace(definition,old_check,
        'IF TG_OP = ''UPDATE'' AND NEW.contractor_id IS DISTINCT FROM OLD.contractor_id
            AND NOT public.company_merge_authorized() THEN');
END;
$$;

-- Extend exclusion lookup to immutable predecessors without changing original unlink records.
CREATE OR REPLACE FUNCTION public.guard_unlinked_registration() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM compliance_record_unlinks WHERE record_id=NEW.id) THEN
        IF NEW.active OR NEW.is_current OR NEW.contractor_id IS DISTINCT FROM OLD.contractor_id
            OR NEW.compliance_type_id IS DISTINCT FROM OLD.compliance_type_id
            OR NEW.registration_number IS DISTINCT FROM OLD.registration_number THEN
            RAISE EXCEPTION 'This historical registration relationship was administratively unlinked' USING ERRCODE='23514';
        END IF;
    END IF;
    IF NEW.active AND NEW.is_current AND EXISTS(SELECT 1 FROM compliance_types
        WHERE id=NEW.compliance_type_id AND compliance_name IN ('NJ PWC','NJ BRC')) THEN
        PERFORM 1 FROM contractors WHERE id=NEW.contractor_id FOR UPDATE;
        IF EXISTS(SELECT 1 FROM compliance_record_unlinks u
            WHERE u.contractor_id=ANY(company_merge_ancestors(NEW.contractor_id))
                AND u.compliance_type_id=NEW.compliance_type_id
                AND u.registration_key=registration_identity_key(NEW.registration_number)) THEN
            RAISE EXCEPTION 'Previously unlinked contractor/registration match is excluded; review a corrected registration instead'
                USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Preserve terminal evidence on its actual searched/imported identity. Snapshot every dependency.
CREATE FUNCTION public.company_merge_snapshot(p_primary INTEGER,p_secondary INTEGER) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tables TEXT[]:=ARRAY[
    'contractors','contractor_projects','contractor_tiered_subs','contractor_contacts','compliance_records',
    'documents','activity_log','contractor_followups','reminders','contractor_insurance','contractor_insurance_history',
    'mycoi_vendor_mappings','mycoi_policies','procore_vendor_mappings','procore_import_lineage',
    'communication_contractors','communication_insurance_items','compliance_sync_review_queue',
    'compliance_sync_exceptions','compliance_sync_search_requests','nj_brc_search_requests',
    'nj_pwc_sync_state','nj_pwc_sync_exceptions','compliance_record_unlinks','contractor_contact_consolidation_lineage'];
    result JSONB:='{}'; name TEXT; predicate TEXT; data JSONB; message_ids UUID[];
BEGIN
    FOREACH name IN ARRAY tables LOOP
        predicate:=CASE WHEN name='contractors' THEN 'id=ANY($1)'
            WHEN name='contractor_tiered_subs' THEN 'contractor_id=ANY($1) OR tiered_sub_contractor_id=ANY($1)'
            ELSE 'contractor_id=ANY($1)' END;
        EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]'')
            FROM public.%I t WHERE %s',name,predicate) INTO data USING ARRAY[p_primary,p_secondary];
        result:=result||jsonb_build_object(name,data);
    END LOOP;
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO data FROM mycoi_contractor_divisions t
        WHERE vendor_mapping_id IN (SELECT id FROM mycoi_vendor_mappings WHERE contractor_id IN(p_primary,p_secondary));
    result:=result||jsonb_build_object('mycoi_contractor_divisions',data);
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO data FROM mycoi_division_mappings t
        WHERE id IN(SELECT division_mapping_id FROM mycoi_contractor_divisions
            WHERE vendor_mapping_id IN(SELECT id FROM mycoi_vendor_mappings WHERE contractor_id IN(p_primary,p_secondary)));
    result:=result||jsonb_build_object('mycoi_division_mappings',data);
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.policy_id,t.contractor_division_id),'[]') INTO data
        FROM mycoi_policy_divisions t WHERE policy_id IN(SELECT id FROM mycoi_policies WHERE contractor_id IN(p_primary,p_secondary));
    result:=result||jsonb_build_object('mycoi_policy_divisions',data);
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO data FROM communication_recipients t
        WHERE contractor_contact_id IN(SELECT id FROM contractor_contacts WHERE contractor_id IN(p_primary,p_secondary));
    result:=result||jsonb_build_object('communication_recipients',data);
    SELECT coalesce(array_agg(DISTINCT message_id),'{}') INTO message_ids FROM (
        SELECT message_id FROM communication_recipients WHERE contractor_contact_id IN(
            SELECT id FROM contractor_contacts WHERE contractor_id IN(p_primary,p_secondary))
        UNION SELECT message_id FROM communication_contractors WHERE contractor_id IN(p_primary,p_secondary)
        UNION SELECT message_id FROM communication_insurance_items WHERE contractor_id IN(p_primary,p_secondary)
        UNION SELECT message_id FROM communication_compliance_items WHERE compliance_record_id IN(
            SELECT id FROM compliance_records WHERE contractor_id IN(p_primary,p_secondary))
        UNION SELECT message_id FROM communication_mycoi_items WHERE policy_id IN(
            SELECT id FROM mycoi_policies WHERE contractor_id IN(p_primary,p_secondary))
    ) linked;
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO data FROM communication_messages t
        WHERE id=ANY(message_ids);
    result:=result||jsonb_build_object('communication_messages',data);
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.message_id,t.compliance_record_id),'[]') INTO data FROM communication_compliance_items t
        WHERE message_id=ANY(message_ids);
    result:=result||jsonb_build_object('communication_compliance_items',data);
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.message_id,t.policy_id),'[]') INTO data FROM communication_mycoi_items t
        WHERE message_id=ANY(message_ids);
    result:=result||jsonb_build_object('communication_mycoi_items',data);
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO data FROM mycoi_import_runs t
        WHERE finalized_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_each_text(t.decisions->'vendors') v
            WHERE v.value IN(p_primary::text,p_secondary::text));
    result:=result||jsonb_build_object('mycoi_import_runs',data);
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') INTO data FROM procore_import_runs t
        WHERE finalized_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_each(t.decisions->'vendors') v
            WHERE v.value->>'action'='MATCH' AND v.value->>'contractorId' IN(p_primary::text,p_secondary::text));
    RETURN result||jsonb_build_object('procore_import_runs',data);
END;
$$;

CREATE FUNCTION public.company_merge_preview(p_primary INTEGER,p_secondary INTEGER,p_actor UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.contractors; b public.contractors; snapshot JSONB; primary_snapshot JSONB; secondary_snapshot JSONB;
    counts JSONB:='{}'; name TEXT;
    blockers JSONB:='[]'; groups JSONB; contacts JSONB; projects JSONB; expected TEXT[];
BEGIN
    PERFORM company_merge_actor(p_actor);
    IF p_primary IS NULL OR p_secondary IS NULL OR p_primary=p_secondary THEN
        RAISE EXCEPTION 'Choose two different companies' USING ERRCODE='22023';
    END IF;
    SELECT * INTO STRICT a FROM contractors WHERE id=p_primary;
    SELECT * INTO STRICT b FROM contractors WHERE id=p_secondary;
    IF a.merged_into_contractor_id IS NOT NULL OR b.merged_into_contractor_id IS NOT NULL THEN
        RAISE EXCEPTION 'Merged predecessors cannot be selected; use their successor' USING ERRCODE='40001';
    END IF;
    snapshot:=company_merge_snapshot(p_primary,p_secondary);
    expected:=ARRAY['contractors','company_merges','contractor_projects','contractor_tiered_subs','contractor_contacts',
        'compliance_records','documents','activity_log','contractor_followups','reminders','contractor_insurance',
        'contractor_insurance_history','mycoi_vendor_mappings','mycoi_policies','procore_vendor_mappings',
        'procore_import_lineage','communication_contractors','communication_insurance_items','compliance_sync_review_queue',
        'compliance_sync_exceptions','compliance_sync_search_requests','nj_brc_search_requests','nj_pwc_sync_state',
        'nj_pwc_sync_exceptions','compliance_record_unlinks'];
    IF EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute att ON att.attrelid=c.oid AND att.attnum=ANY(k.conkey)
        WHERE k.contype='f' AND k.confrelid='public.contractors'::regclass AND NOT (
            n.nspname='public' AND c.relname=ANY(expected) AND cardinality(k.conkey)=1 AND (
                (c.relname='contractors' AND att.attname='merged_into_contractor_id')
                OR (c.relname='company_merges' AND att.attname IN('primary_id','secondary_id','successor_id'))
                OR (c.relname NOT IN('contractors','company_merges') AND att.attname='contractor_id')
                OR (c.relname='contractor_tiered_subs' AND att.attname='tiered_sub_contractor_id')))) THEN
        blockers:=blockers||jsonb_build_array('Unrecognized contractor dependency: catalogue review required.');
    END IF;
    primary_snapshot:=company_merge_snapshot(p_primary,p_primary);
    secondary_snapshot:=company_merge_snapshot(p_secondary,p_secondary);
    FOR name IN SELECT jsonb_object_keys(snapshot) LOOP
        counts:=counts||jsonb_build_object(name,jsonb_build_object(
            'primary',jsonb_array_length(primary_snapshot->name),
            'secondary',jsonb_array_length(secondary_snapshot->name)));
    END LOOP;
    IF EXISTS(SELECT 1 FROM compliance_sync_search_requests WHERE contractor_id IN(p_primary,p_secondary)
        AND status IN('pending','claimed','processing')) THEN
        blockers:=blockers||jsonb_build_array('Pending or in-flight registry search. Complete or explicitly stop it first.');
    END IF;
    IF EXISTS(SELECT 1 FROM nj_brc_search_requests WHERE contractor_id IN(p_primary,p_secondary)
        AND status IN('pending','claimed','processing','human_verification_required','review_required')) THEN
        blockers:=blockers||jsonb_build_array('Actionable immutable NJ BRC request. Complete its normal workflow first.');
    END IF;
    IF EXISTS(SELECT 1 FROM compliance_sync_review_queue WHERE contractor_id IN(p_primary,p_secondary) AND status='pending')
        OR EXISTS(SELECT 1 FROM nj_pwc_sync_exceptions WHERE contractor_id IN(p_primary,p_secondary) AND status='open')
        OR EXISTS(SELECT 1 FROM compliance_sync_exceptions WHERE contractor_id IN(p_primary,p_secondary) AND NOT resolved) THEN
        blockers:=blockers||jsonb_build_array('Open sync review or exception. Resolve it through the existing workflow before merging.');
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'communication_messages') v WHERE v->>'status' IN('Draft','Queued','Sending')) THEN
        blockers:=blockers||jsonb_build_array('Affected draft or in-flight communication. Review it before merging.');
    END IF;
    IF EXISTS(SELECT 1 FROM contractor_followups WHERE contractor_id IN(p_primary,p_secondary) AND status IN('Open','Waiting Response'))
        OR EXISTS(SELECT 1 FROM reminders WHERE contractor_id IN(p_primary,p_secondary) AND sent_date IS NULL AND resolved_date IS NULL) THEN
        blockers:=blockers||jsonb_build_array('Open follow-up or unsent reminder. Close/review it before merging; no automatic sending or reassignment.');
    END IF;
    IF EXISTS(
        WITH RECURSIVE edges AS (
            SELECT CASE WHEN contractor_id IN(p_primary,p_secondary) THEN 0 ELSE contractor_id END parent_id,
                CASE WHEN tiered_sub_contractor_id IN(p_primary,p_secondary) THEN 0 ELSE tiered_sub_contractor_id END child_id
            FROM contractor_tiered_subs WHERE active
        ), paths(node,seen) AS (
            SELECT child_id,ARRAY[0,child_id] FROM edges WHERE parent_id=0 AND child_id<>0
            UNION ALL
            SELECT e.child_id,p.seen||e.child_id FROM paths p JOIN edges e ON e.parent_id=p.node
                WHERE p.node<>0 AND (e.child_id=0 OR NOT e.child_id=ANY(p.seen))
        ) SELECT 1 FROM paths WHERE node=0
    ) THEN
        blockers:=blockers||jsonb_build_array('Tiered relationship union would create a cycle through the merged company. Review the edges first.');
    END IF;
    IF EXISTS(SELECT 1 FROM mycoi_import_runs r CROSS JOIN LATERAL jsonb_each(coalesce(r.decisions->'vendors','{}')) d
        WHERE r.finalized_at IS NULL AND d.value IN(to_jsonb(p_primary),to_jsonb(p_secondary)))
        OR EXISTS(SELECT 1 FROM procore_import_runs r CROSS JOIN LATERAL jsonb_each(coalesce(r.decisions->'vendors','{}')) d
            WHERE r.finalized_at IS NULL AND d.value->>'action'='MATCH'
                AND d.value->>'contractorId' IN(p_primary::text,p_secondary::text)) THEN
        blockers:=blockers||jsonb_build_array('An unfinished import explicitly selects a predecessor. Remove that decision or finalize the import first.');
    END IF;
    SELECT coalesce(jsonb_agg(g ORDER BY compliance_type_id),'[]') INTO groups FROM (
        SELECT cr.compliance_type_id,ct.compliance_name,jsonb_agg(to_jsonb(cr) ORDER BY cr.id) records
        FROM compliance_records cr JOIN compliance_types ct ON ct.id=cr.compliance_type_id
        WHERE cr.contractor_id IN(p_primary,p_secondary) AND cr.active AND cr.is_current
        GROUP BY cr.compliance_type_id,ct.compliance_name) g;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'contractor_id',contractor_id,'contact_name',contact_name,
        'is_primary_contact',is_primary_contact,'is_active',is_active) ORDER BY id),'[]') INTO contacts
        FROM contractor_contacts WHERE contractor_id IN(p_primary,p_secondary);
    SELECT jsonb_build_object('primary',count(*) FILTER(WHERE contractor_id=p_primary),
        'secondary',count(*) FILTER(WHERE contractor_id=p_secondary),
        'union',count(DISTINCT project_id),'shared',count(*)-count(DISTINCT project_id)) INTO projects
        FROM contractor_projects WHERE contractor_id IN(p_primary,p_secondary) AND active;
    RETURN jsonb_build_object('primary',to_jsonb(a),'secondary',to_jsonb(b),
        'snapshot',md5(snapshot::text),'fields',to_jsonb(company_merge_fields()),'counts',counts,
        'projects',projects,'compliance',groups,'contacts',contacts,'blockers',blockers);
END;
$$;

CREATE FUNCTION public.company_merge_execute(
    p_primary INTEGER,p_secondary INTEGER,p_snapshot TEXT,p_choices JSONB,p_compliance JSONB,
    p_primary_contact UUID,p_operation UUID,p_confirmed BOOLEAN,p_actor UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.user_profiles; preview JSONB; snapshot JSONB; a JSONB; b JSONB; chosen JSONB:='{}';
    name TEXT; entry RECORD; row_data JSONB; fields TEXT[]:=company_merge_fields(); successor INTEGER;
    value_record public.contractors; selected_record_id INTEGER; selected_ids INTEGER[]:='{}'; kind JSONB; authority RECORD;
    request JSONB; response JSONB; receipt public.company_merges; sources TEXT[]; resulting_id INTEGER;
BEGIN
    actor:=company_merge_actor(p_actor);
    PERFORM set_config('lock_timeout','5s',true);
    IF p_confirmed IS DISTINCT FROM true OR p_operation IS NULL THEN
        RAISE EXCEPTION 'Explicit irreversible confirmation and operation identity required' USING ERRCODE='22023';
    END IF;
    request:=jsonb_build_object('primary',p_primary,'secondary',p_secondary,'snapshot',p_snapshot,
        'choices',p_choices,'compliance',p_compliance,'primary_contact',p_primary_contact,'actor',p_actor);
    PERFORM pg_advisory_xact_lock(hashtext('company_merge'));
    SELECT * INTO receipt FROM company_merges WHERE id=p_operation;
    IF FOUND THEN
        IF receipt.snapshot->'request' IS DISTINCT FROM request THEN
            RAISE EXCEPTION 'Operation identity already used with different choices' USING ERRCODE='40001';
        END IF;
        RETURN receipt.result||jsonb_build_object('already_processed',true);
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('mycoi_manual_import'));
    PERFORM pg_advisory_xact_lock(hashtext('procore_manual_import'));
    PERFORM pg_advisory_xact_lock(hashtext('contractor_project_ownership'));
    PERFORM pg_advisory_xact_lock(61015,1);
    PERFORM 1 FROM user_profiles WHERE auth_user_id=p_actor FOR SHARE;
    PERFORM 1 FROM role_permissions WHERE role=actor.role AND module='company_merge' FOR SHARE;
    actor:=company_merge_actor(p_actor);
    -- Rare administrative operation: block all concurrent writes to the dependency graph
    -- while revalidating. Row locks alone would not protect new child rows or new jobs.
    LOCK TABLE public.contractors,public.projects,public.contractor_projects,public.contractor_tiered_subs,
        public.contractor_contacts,public.compliance_records,public.compliance_record_unlinks,
        public.documents,public.activity_log,public.contractor_followups,public.reminders,
        public.contractor_insurance,public.contractor_insurance_history,
        public.mycoi_vendor_mappings,public.mycoi_policies,public.mycoi_division_mappings,
        public.mycoi_contractor_divisions,public.mycoi_policy_divisions,
        public.procore_vendor_mappings,public.procore_import_lineage,public.mycoi_import_runs,public.procore_import_runs,
        public.communication_messages,public.communication_recipients,public.communication_contractors,
        public.communication_insurance_items,public.communication_compliance_items,public.communication_mycoi_items,
        public.compliance_sync_review_queue,public.compliance_sync_exceptions,public.compliance_sync_search_requests,
        public.nj_brc_search_requests,public.nj_pwc_sync_state,public.nj_pwc_sync_exceptions,
        public.contractor_contact_consolidation_lineage IN SHARE ROW EXCLUSIVE MODE;
    PERFORM 1 FROM contractors WHERE id IN(p_primary,p_secondary) ORDER BY id FOR UPDATE;
    preview:=company_merge_preview(p_primary,p_secondary,p_actor);
    IF p_snapshot IS NULL OR p_snapshot IS DISTINCT FROM preview->>'snapshot' THEN
        RAISE EXCEPTION 'Company dependencies changed; reload preview' USING ERRCODE='40001';
    END IF;
    IF jsonb_array_length(preview->'blockers')>0 THEN
        RAISE EXCEPTION 'Merge blocked: %',preview->'blockers' USING ERRCODE='55000';
    END IF;
    IF jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR jsonb_typeof(p_compliance) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Explicit field and compliance decisions required' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_choices))<>cardinality(fields)
        OR EXISTS(SELECT 1 FROM jsonb_each_text(p_choices) WHERE NOT key=ANY(fields)
            OR value IS NULL OR value NOT IN('primary','secondary')) THEN
        RAISE EXCEPTION 'Choose Primary or Secondary for every company field' USING ERRCODE='22023';
    END IF;
    snapshot:=company_merge_snapshot(p_primary,p_secondary);
    a:=preview->'primary'; b:=preview->'secondary';
    FOREACH name IN ARRAY fields LOOP
        chosen:=chosen||jsonb_build_object(name,CASE WHEN p_choices->>name='primary' THEN a->name ELSE b->name END);
    END LOOP;
    IF nullif(btrim(chosen->>'company_name'),'') IS NULL THEN
        RAISE EXCEPTION 'Company name is required' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_compliance))<>jsonb_array_length(preview->'compliance') THEN
        RAISE EXCEPTION 'Explicitly select the current record for every compliance type' USING ERRCODE='22023';
    END IF;
    FOR kind IN SELECT value FROM jsonb_array_elements(preview->'compliance') LOOP
        IF NOT coalesce((p_compliance->>(kind->>'compliance_type_id'))~'^[1-9][0-9]*$',false) THEN
            RAISE EXCEPTION 'Select a current compliance record for %',kind->>'compliance_name' USING ERRCODE='22023';
        END IF;
        selected_record_id:=(p_compliance->>(kind->>'compliance_type_id'))::integer;
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(kind->'records') r WHERE (r->>'id')::integer=selected_record_id) THEN
            RAISE EXCEPTION 'Current compliance selection is stale or does not belong to this type' USING ERRCODE='40001';
        END IF;
        IF EXISTS(SELECT 1 FROM compliance_record_unlinks u JOIN compliance_records c ON c.id=selected_record_id
            WHERE u.contractor_id=ANY(company_merge_ancestors(p_primary)||company_merge_ancestors(p_secondary))
                AND u.compliance_type_id=c.compliance_type_id
                AND u.registration_key=registration_identity_key(c.registration_number)) THEN
            RAISE EXCEPTION 'Selected registration was previously unlinked from a predecessor' USING ERRCODE='23514';
        END IF;
        selected_ids:=array_append(selected_ids,selected_record_id);
    END LOOP;
    IF p_primary_contact IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contractor_contacts
        WHERE id=p_primary_contact AND contractor_id IN(p_primary,p_secondary) AND is_active) THEN
        RAISE EXCEPTION 'Choose an active contact from one of these companies' USING ERRCODE='22023';
    END IF;
    IF p_primary_contact IS NULL AND EXISTS(SELECT 1 FROM contractor_contacts
        WHERE contractor_id IN(p_primary,p_secondary) AND is_active AND is_primary_contact) THEN
        RAISE EXCEPTION 'Explicitly choose the resulting primary contact' USING ERRCODE='22023';
    END IF;
    INSERT INTO company_merge_authorizations VALUES(pg_backend_pid(),txid_current(),p_operation);
    SELECT * INTO value_record FROM jsonb_populate_record(NULL::public.contractors,chosen);
    INSERT INTO contractors(company_name,trade,contact_name,email,phone,address_1,address_2,city,state,zip_code,county,
        federal_tax_id,sage_erp_id,external_id,legacy_id,notes,material_vendor_only,brc_name_control,
        brc_name_control_is_manual,nj_pwc_number,nj_brc_number,ny_pwc_number,ny_brc_number,active,creation_source)
    VALUES(value_record.company_name,value_record.trade,value_record.contact_name,value_record.email,value_record.phone,
        value_record.address_1,value_record.address_2,value_record.city,value_record.state,value_record.zip_code,value_record.county,
        value_record.federal_tax_id,value_record.sage_erp_id,value_record.external_id,value_record.legacy_id,value_record.notes,
        value_record.material_vendor_only,value_record.brc_name_control,value_record.brc_name_control_is_manual,
        value_record.nj_pwc_number,value_record.nj_brc_number,
        value_record.ny_pwc_number,value_record.ny_brc_number,value_record.active,'MERGE') RETURNING id INTO successor;
    response:=jsonb_build_object('merge_id',p_operation,'successor_id',successor);
    INSERT INTO company_merges(id,primary_id,secondary_id,successor_id,actor_id,choices,compliance_choices,snapshot,result)
    VALUES(p_operation,p_primary,p_secondary,successor,p_actor,p_choices,p_compliance,
        jsonb_build_object('request',request,'dependencies',snapshot,'primary_contact',p_primary_contact),response);
    FOR name IN SELECT jsonb_object_keys(snapshot) LOOP
        FOR row_data IN SELECT value FROM jsonb_array_elements(snapshot->name) LOOP
            INSERT INTO company_merge_lineage(merge_id,category,source_id,before_row)
                VALUES(p_operation,name,coalesce(row_data->>'id',md5(row_data::text)),row_data);
        END LOOP;
    END LOOP;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import','',true);
    -- Original rows remain history; the new live union retains imported sources and
    -- an explicit MERGE preservation source, never invented MANUAL ownership.
    FOR entry IN SELECT project_id,min(assigned_date) assigned_date,array_agg(id ORDER BY id) old_ids
        FROM contractor_projects WHERE contractor_id IN(p_primary,p_secondary) AND active GROUP BY project_id LOOP
        SELECT array_agg(DISTINCT s ORDER BY s) INTO sources FROM contractor_projects p
            CROSS JOIN LATERAL unnest(p.ownership_sources||ARRAY['MERGE']) s WHERE p.id=ANY(entry.old_ids);
        INSERT INTO contractor_projects(contractor_id,project_id,assigned_date,active,ownership_sources)
            VALUES(successor,entry.project_id,entry.assigned_date,true,sources) RETURNING id INTO resulting_id;
        UPDATE company_merge_lineage SET after_row=jsonb_build_object('assignment_id',resulting_id,
            'contractor_id',successor,'ownership_sources',sources) WHERE merge_id=p_operation
            AND category='contractor_projects' AND source_id=ANY(SELECT unnest(entry.old_ids)::text);
    END LOOP;
    UPDATE contractor_projects SET active=false,ownership_sources='{}',removed_date=greatest(current_date,assigned_date)
        WHERE contractor_id IN(p_primary,p_secondary) AND active;
    FOR entry IN SELECT
        CASE WHEN contractor_id IN(p_primary,p_secondary) THEN successor ELSE contractor_id END parent_id,
        CASE WHEN tiered_sub_contractor_id IN(p_primary,p_secondary) THEN successor ELSE tiered_sub_contractor_id END child_id,
        min(assigned_date) assigned_date,array_agg(id ORDER BY id) old_ids
        FROM contractor_tiered_subs WHERE active AND (contractor_id IN(p_primary,p_secondary)
            OR tiered_sub_contractor_id IN(p_primary,p_secondary)) GROUP BY 1,2 LOOP
        resulting_id:=NULL;
        IF entry.parent_id<>entry.child_id THEN
            INSERT INTO contractor_tiered_subs(contractor_id,tiered_sub_contractor_id,assigned_date,active)
                VALUES(entry.parent_id,entry.child_id,entry.assigned_date,true) RETURNING id INTO resulting_id;
        END IF;
        UPDATE company_merge_lineage SET after_row=jsonb_build_object('tiered_sub_id',resulting_id,
            'contractor_id',entry.parent_id,'tiered_sub_contractor_id',entry.child_id,
            'retired_internal_edge',entry.parent_id=entry.child_id) WHERE merge_id=p_operation
                AND category='contractor_tiered_subs' AND source_id=ANY(SELECT unnest(entry.old_ids)::text);
    END LOOP;
    UPDATE contractor_tiered_subs SET active=false,removed_date=greatest(current_date,assigned_date)
        WHERE active AND (contractor_id IN(p_primary,p_secondary) OR tiered_sub_contractor_id IN(p_primary,p_secondary));
    UPDATE contractor_contacts SET is_primary_contact=false
        WHERE contractor_id IN(p_primary,p_secondary) AND is_primary_contact;
    UPDATE contractor_contacts SET contractor_id=successor WHERE contractor_id IN(p_primary,p_secondary);
    IF p_primary_contact IS NOT NULL THEN
        UPDATE contractor_contacts SET is_primary_contact=true WHERE id=p_primary_contact;
    END IF;
    UPDATE company_merge_lineage l SET after_row=to_jsonb(c) FROM contractor_contacts c
        WHERE l.merge_id=p_operation AND l.category='contractor_contacts' AND l.source_id=c.id::text;
    -- Never transfer an excluded historical record. Keep every nonselected version,
    -- including former current records, under its original company.
    UPDATE compliance_records SET active=false,is_current=false,updated_at=now()
        WHERE contractor_id IN(p_primary,p_secondary) AND (active OR is_current) AND NOT id=ANY(selected_ids);
    UPDATE compliance_records SET contractor_id=successor,updated_at=now() WHERE id=ANY(selected_ids);
    FOR authority IN SELECT c.compliance_name,r.registration_number
        FROM compliance_records r JOIN compliance_types c ON c.id=r.compliance_type_id
        WHERE r.id=ANY(selected_ids) AND c.compliance_name IN('NJ PWC','NJ BRC','NY PWC','NY BRC')
    LOOP
        EXECUTE format('UPDATE contractors SET %I=$1 WHERE id=$2',
            CASE authority.compliance_name WHEN 'NJ PWC' THEN 'nj_pwc_number' WHEN 'NJ BRC' THEN 'nj_brc_number'
                WHEN 'NY PWC' THEN 'ny_pwc_number' ELSE 'ny_brc_number' END)
            USING authority.registration_number,successor;
    END LOOP;
    UPDATE company_merge_lineage l SET after_row=to_jsonb(c) FROM compliance_records c
        WHERE l.merge_id=p_operation AND l.category='compliance_records' AND l.source_id=c.id::text;
    UPDATE mycoi_vendor_mappings SET active=false,updated_at=now() WHERE contractor_id IN(p_primary,p_secondary) AND active;
    -- No active flag exists on this authoritative lookup. Permanent before images
    -- above retain its key, source run, actor and history; the next import must rematch.
    DELETE FROM procore_vendor_mappings WHERE contractor_id IN(p_primary,p_secondary);
    UPDATE contractors SET active=false,merged_into_contractor_id=successor,updated_at=now()
        WHERE id IN(p_primary,p_secondary);
    INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
        VALUES(p_actor,actor.name,actor.email,'COMPANIES_MERGED','contractor',successor::text,value_record.company_name,
            response||jsonb_build_object('primary_id',p_primary,'secondary_id',p_secondary,
                'choices',p_choices,'compliance_choices',p_compliance,'primary_contact',p_primary_contact,
                'rematch_required',ARRAY['MYCOI','PROCORE']));
    INSERT INTO activity_log(contractor_id,activity_type,notes,created_by)
        VALUES(successor,'Company Merge','Merged predecessor #'||p_primary||' and #'||p_secondary||
            '; original source evidence retained; myCOI and Procore rematching required.',actor.email);
    IF (SELECT count(*) FROM contractors WHERE id IN(p_primary,p_secondary) AND NOT active
        AND merged_into_contractor_id=successor)<>2 THEN RAISE EXCEPTION 'Merge archival postcondition failed'; END IF;
    DELETE FROM company_merge_authorizations WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
    RETURN response;
END;
$$;

-- Reference readers must not suggest archived identities. Existing match/import
-- transaction writers are additionally protected by the dependency guards above.
ALTER FUNCTION public.mycoi_import_reference() RENAME TO mycoi_import_reference_before_company_merge;
ALTER FUNCTION public.procore_import_reference() RENAME TO procore_import_reference_before_company_merge;
CREATE FUNCTION public.company_merge_filter_reference(p_reference JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result JSONB:=p_reference; field TEXT; data JSONB;
BEGIN
    FOREACH field IN ARRAY ARRAY['contractors','vendors','contacts'] LOOP
        IF jsonb_typeof(result->field)='array' THEN
            SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') INTO data FROM jsonb_array_elements(result->field) v
                WHERE NOT EXISTS(SELECT 1 FROM contractors c WHERE c.merged_into_contractor_id IS NOT NULL
                    AND c.id=CASE WHEN field='contractors' THEN (v->>'id')::integer ELSE (v->>'contractor_id')::integer END);
            result:=jsonb_set(result,ARRAY[field],data);
        END IF;
    END LOOP;
    RETURN jsonb_set(result,'{token}',to_jsonb(md5((result-'token')::text)));
END;
$$;
CREATE FUNCTION public.mycoi_import_reference() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT company_merge_filter_reference(mycoi_import_reference_before_company_merge());
$$;
CREATE FUNCTION public.procore_import_reference() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT company_merge_filter_reference(procore_import_reference_before_company_merge());
$$;

REVOKE ALL ON FUNCTION public.company_merge_authorized(),public.company_merge_actor(UUID),
    public.company_merge_fields(),public.company_merge_ancestors(INTEGER),public.company_merge_guard(),
    public.company_merge_snapshot(INTEGER,INTEGER),public.company_merge_preview(INTEGER,INTEGER,UUID),
    public.company_merge_execute(INTEGER,INTEGER,TEXT,JSONB,JSONB,UUID,UUID,BOOLEAN,UUID),
    public.company_merge_filter_reference(JSONB),
    public.mycoi_import_reference_before_company_merge(),public.procore_import_reference_before_company_merge(),
    public.mycoi_import_reference(),public.procore_import_reference()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.company_merge_preview(INTEGER,INTEGER,UUID),
    public.company_merge_execute(INTEGER,INTEGER,TEXT,JSONB,JSONB,UUID,UUID,BOOLEAN,UUID),
    public.mycoi_import_reference(),public.procore_import_reference() TO service_role;
COMMIT;
