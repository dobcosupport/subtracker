-- Awaiting manual approval/application. No contacts or existing rows are changed.
BEGIN;

CREATE TABLE public.company_contact_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 250),
    file_hash TEXT NOT NULL UNIQUE CHECK(file_hash ~ '^[0-9a-f]{64}$'),
    created_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'Review' CHECK(status IN ('Review','Partial','Complete')),
    notices JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(notices)='array'),
    import_history_id INTEGER NOT NULL REFERENCES public.import_history(id) ON DELETE RESTRICT
);
CREATE INDEX company_contact_import_batches_history ON public.company_contact_import_batches(created_at DESC,id);
CREATE TABLE public.company_contact_import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES public.company_contact_import_batches(id) ON DELETE RESTRICT,
    source_row INTEGER NOT NULL CHECK(source_row >= 2),
    original JSONB NOT NULL,
    normalized JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'REVIEW' CHECK(status IN ('NEW','MATCHED','REVIEW','SKIP','IMPORTED','UPDATED','ERROR')),
    resolution JSONB,
    contact_id UUID REFERENCES public.dobco_contacts(id) ON DELETE RESTRICT,
    error TEXT,
    before_contact JSONB,
    after_contact JSONB,
    events JSONB NOT NULL DEFAULT '[]',
    UNIQUE(batch_id,source_row)
);
CREATE INDEX company_contact_import_rows_contact ON public.company_contact_import_rows(contact_id) WHERE contact_id IS NOT NULL;
ALTER TABLE public.company_contact_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_contact_import_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_contact_import_batches,public.company_contact_import_rows FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.company_contact_import_values(p_values JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT jsonb_build_object('contact_name',btrim(coalesce(p_values->>'contact_name','')),
        'email',nullif(btrim(p_values->>'email'),''),
        'mobile_phone',nullif(btrim(p_values->>'mobile_phone'),''));
$$;
CREATE FUNCTION public.company_contact_import_issues(p_values JSONB) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT array_remove(ARRAY[
        CASE WHEN coalesce(p_values->>'contact_name','') !~ '[^[:space:]]' THEN 'Name is required.' END,
        CASE WHEN length(p_values->>'contact_name')>250 OR length(p_values->>'email')>320 OR length(p_values->>'mobile_phone')>100
            THEN 'Use Name up to 250, Email up to 320 and Cell up to 100 characters.' END,
        CASE WHEN p_values->>'email' IS NOT NULL AND p_values->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
            THEN 'Enter a valid email or leave it blank; source notes are preserved in history.' END,
        CASE WHEN p_values->>'mobile_phone' IS NOT NULL AND (p_values->>'mobile_phone' !~ '^[+0-9().[:space:]-]+$'
            OR length(regexp_replace(p_values->>'mobile_phone','[^0-9]','','g')) NOT BETWEEN 7 AND 15)
            THEN 'Review Cell: use a phone number without notes, or leave it blank.' END,
        CASE WHEN p_values->>'contact_name' ~ '[()]' THEN 'Review Name: remove parenthetical notes from the proposed name or keep the existing contact.' END
    ],NULL);
$$;
CREATE FUNCTION public.company_contact_import_keys(p_values JSONB) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT array_remove(ARRAY[
        CASE WHEN nullif(btrim(p_values->>'email'),'') IS NOT NULL THEN 'email:'||lower(btrim(p_values->>'email')) END,
        CASE WHEN length(regexp_replace(p_values->>'mobile_phone','[^0-9]','','g'))>=7
            THEN 'cell:'||regexp_replace(p_values->>'mobile_phone','[^0-9]','','g') END,
        CASE WHEN nullif(btrim(p_values->>'contact_name'),'') IS NOT NULL
            THEN 'name:'||lower(regexp_replace(btrim(p_values->>'contact_name'),'[[:space:]]+',' ','g')) END
    ],NULL);
$$;
ALTER TABLE public.company_contact_import_rows ADD COLUMN matching_keys TEXT[]
    GENERATED ALWAYS AS (public.company_contact_import_keys(normalized)) STORED;

-- Only the server may supply an actor; API roles cannot invoke helpers or bypass the permission gate.
CREATE FUNCTION public.company_contacts_import(p_action TEXT,p_actor UUID,p_data JSONB DEFAULT '{}') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE
    actor public.user_profiles;
    batch public.company_contact_import_batches;
    item public.company_contact_import_rows;
    contact public.dobco_contacts;
    old_contact public.dobco_contacts;
    source JSONB;
    values_in JSONB;
    decision JSONB;
    result JSONB;
    rows_json JSONB;
    summary JSONB;
    contact_list JSONB;
    action TEXT;
    contact_uuid UUID;
    history_id INTEGER;
    failure TEXT;
    error_state TEXT;
    duplicate BOOLEAN;
    write_operation BOOLEAN := p_action IN ('stage','resolve','apply');
BEGIN
    IF p_action IS NULL OR p_action NOT IN ('list','get','stage','resolve','apply') THEN
        RAISE EXCEPTION 'Unknown Company Contacts import operation' USING ERRCODE='22023';
    END IF;
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active';
    IF actor.auth_user_id IS NULL OR (NOT coalesce(actor.system_administrator,false) AND EXISTS(
        SELECT 1 FROM (VALUES('imports'),('settings')) needed(module)
        WHERE NOT EXISTS(SELECT 1 FROM role_permissions p WHERE p.role=actor.role AND p.module=needed.module AND p.can_view
            AND (NOT write_operation OR CASE WHEN needed.module='settings' THEN p.can_manage ELSE p.can_add AND p.can_edit END))
    )) THEN RAISE EXCEPTION 'Company Contacts requires Import View/Add/Edit and Settings View/Manage permissions' USING ERRCODE='42501'; END IF;
    IF write_operation THEN PERFORM pg_advisory_xact_lock(hashtext('company_contacts_import')); END IF;

    IF p_action='list' THEN
        IF coalesce(p_data->>'offset','0') !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'Invalid history offset' USING ERRCODE='22023'; END IF;
        RETURN jsonb_build_object('batches',coalesce((SELECT jsonb_agg(to_jsonb(b)) FROM
            (SELECT id,file_name,created_by,created_at,status,revision FROM company_contact_import_batches
                ORDER BY created_at DESC,id LIMIT 20 OFFSET coalesce((p_data->>'offset')::integer,0)) b),'[]'::jsonb));
    END IF;
    IF p_action='stage' THEN
        IF jsonb_typeof(p_data->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'rows') NOT BETWEEN 1 AND 2000
            OR coalesce(length(p_data->>'file_name'),0) NOT BETWEEN 1 AND 250
            OR coalesce(p_data->>'file_hash','') !~ '^[0-9a-f]{64}$' THEN
            RAISE EXCEPTION 'Invalid Company Contacts upload' USING ERRCODE='22023';
        END IF;
        SELECT * INTO batch FROM company_contact_import_batches WHERE file_hash=p_data->>'file_hash' FOR UPDATE;
        IF NOT FOUND THEN
            INSERT INTO import_history(file_name,imported_rows,notes)
                VALUES(p_data->>'file_name',jsonb_array_length(p_data->'rows'),'Company Contacts; row decisions/results in company_contact_import_rows')
                RETURNING id INTO history_id;
            INSERT INTO company_contact_import_batches(file_name,file_hash,created_by,notices,import_history_id)
                VALUES(p_data->>'file_name',p_data->>'file_hash',p_actor,coalesce(p_data->'notices','[]'),history_id) RETURNING * INTO batch;
            FOR source IN SELECT value FROM jsonb_array_elements(p_data->'rows') LOOP
                IF jsonb_typeof(source->'original') IS DISTINCT FROM 'object'
                    OR NOT (source->'original' ?& ARRAY['Name','Cell','Email'])
                    OR EXISTS(SELECT 1 FROM jsonb_each(source->'original') e WHERE e.key NOT IN ('Name','Cell','Email') OR jsonb_typeof(e.value)<>'string')
                    OR EXISTS(SELECT 1 FROM jsonb_each_text(source->'original') e WHERE length(e.value)>2000)
                    OR coalesce(source->>'source_row','') !~ '^[0-9]{1,5}$' THEN
                    RAISE EXCEPTION 'Invalid source row; nothing was staged' USING ERRCODE='22023';
                END IF;
                values_in := company_contact_import_values(jsonb_build_object('contact_name',source->'original'->>'Name',
                    'mobile_phone',source->'original'->>'Cell','email',source->'original'->>'Email'));
                IF values_in->>'contact_name'='' AND values_in->>'email' IS NULL AND values_in->>'mobile_phone' IS NULL THEN CONTINUE; END IF;
                INSERT INTO company_contact_import_rows(batch_id,source_row,original,normalized)
                    VALUES(batch.id,(source->>'source_row')::integer,source->'original',values_in);
            END LOOP;
            IF NOT EXISTS(SELECT 1 FROM company_contact_import_rows WHERE batch_id=batch.id) THEN
                RAISE EXCEPTION 'No nonblank contact rows' USING ERRCODE='22023';
            END IF;
            INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
                VALUES(p_actor,actor.name,actor.email,'COMPANY_CONTACTS_STAGED','company_contacts_import',batch.id::text,batch.file_name,
                    jsonb_build_object('file_hash',p_data->>'file_hash','source_rows',jsonb_array_length(p_data->'rows')));
        END IF;
    ELSE
        SELECT * INTO batch FROM company_contact_import_batches WHERE id=(p_data->>'batch_id')::uuid FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Company Contacts import not found' USING ERRCODE='P0002'; END IF;
    END IF;

    IF p_action IN ('resolve','apply') THEN
        -- Serializes imports; the table lock also prevents racing manual contact writes during revalidation/application.
        LOCK TABLE dobco_contacts IN SHARE ROW EXCLUSIVE MODE;
        IF batch.revision IS DISTINCT FROM (p_data->>'revision')::integer THEN
            IF p_action<>'apply' OR EXISTS(SELECT 1 FROM company_contact_import_rows WHERE batch_id=batch.id
                AND resolution IS NOT NULL AND status NOT IN ('IMPORTED','UPDATED','SKIP')) THEN
                RAISE EXCEPTION 'Import changed; reload before submitting' USING ERRCODE='40001';
            END IF;
            -- A repeated successful apply is a read, not another contact mutation.
            p_action := 'get';
        END IF;
    END IF;
    IF p_action='resolve' THEN
        SELECT * INTO item FROM company_contact_import_rows WHERE id=(p_data->>'row_id')::uuid AND batch_id=batch.id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Source row not found' USING ERRCODE='P0002'; END IF;
        IF item.status IN ('IMPORTED','UPDATED') THEN RAISE EXCEPTION 'Successful rows are read-only' USING ERRCODE='40001'; END IF;
        action := p_data->>'action';
        IF action IS NULL OR action NOT IN ('ADD','UPDATE','KEEP','SKIP','UNDO') THEN RAISE EXCEPTION 'Choose a row resolution' USING ERRCODE='22023'; END IF;
        contact_uuid := nullif(p_data->>'contact_id','')::uuid;
        IF action NOT IN ('KEEP','UPDATE') THEN contact_uuid := NULL; END IF;
        values_in := company_contact_import_values(p_data->'values');
        old_contact := NULL;
        IF action IN ('KEEP','UPDATE') THEN
            SELECT * INTO old_contact FROM dobco_contacts WHERE id=contact_uuid FOR UPDATE;
            IF NOT FOUND THEN RAISE EXCEPTION 'Select an existing company contact explicitly' USING ERRCODE='22023'; END IF;
            IF p_data->>'contact_version' IS DISTINCT FROM md5(to_jsonb(old_contact)::text) THEN
                RAISE EXCEPTION 'Contact changed; reload and review it again' USING ERRCODE='40001';
            END IF;
        END IF;
        IF action IN ('ADD','UPDATE') THEN
            IF jsonb_typeof(p_data->'values') IS DISTINCT FROM 'object'
                OR NOT (p_data->'values' ?& ARRAY['contact_name','email','mobile_phone'])
                OR EXISTS(SELECT 1 FROM jsonb_each(p_data->'values') e WHERE e.key NOT IN ('contact_name','email','mobile_phone')
                    OR jsonb_typeof(e.value) NOT IN ('string','null')) THEN
                RAISE EXCEPTION 'Provide only Name, Cell and Email values' USING ERRCODE='22023';
            END IF;
            IF action='UPDATE' THEN
                values_in := jsonb_build_object('contact_name',coalesce(nullif(values_in->>'contact_name',''),old_contact.contact_name),
                    'email',coalesce(values_in->>'email',old_contact.email),'mobile_phone',coalesce(values_in->>'mobile_phone',old_contact.mobile_phone));
            END IF;
            IF cardinality(company_contact_import_issues(values_in))>0 THEN
                RAISE EXCEPTION '%',array_to_string(company_contact_import_issues(values_in),' ') USING ERRCODE='22023';
            END IF;
            IF EXISTS(SELECT 1 FROM dobco_contacts c WHERE c.id IS DISTINCT FROM contact_uuid
                AND nullif(lower(btrim(c.email)),'')=lower(values_in->>'email')) THEN
                RAISE EXCEPTION 'Email already belongs to an existing contact; select that contact or Skip' USING ERRCODE='22023';
            END IF;
            duplicate := EXISTS(SELECT 1 FROM dobco_contacts c WHERE c.id IS DISTINCT FROM contact_uuid AND
                company_contact_import_keys(to_jsonb(c)) && company_contact_import_keys(values_in))
                OR EXISTS(SELECT 1 FROM company_contact_import_rows r WHERE r.batch_id=batch.id AND r.id<>item.id AND
                    company_contact_import_keys(r.normalized) && company_contact_import_keys(item.normalized));
            IF duplicate AND coalesce((p_data->>'confirm_duplicate')::boolean,false) IS NOT TRUE THEN
                RAISE EXCEPTION 'Possible duplicate: explicitly acknowledge the duplicate review or choose an existing contact/Skip' USING ERRCODE='22023';
            END IF;
        END IF;
        decision := CASE WHEN action='UNDO' THEN NULL ELSE jsonb_build_object('action',action,'contact_id',
            CASE WHEN action IN ('UPDATE','KEEP') THEN contact_uuid ELSE NULL END,'values',values_in,
            'contact_snapshot',CASE WHEN action IN ('UPDATE','KEEP') THEN to_jsonb(old_contact) ELSE NULL END,
            'confirm_duplicate',coalesce((p_data->>'confirm_duplicate')::boolean,false),
            'approved_by',p_actor,'approved_at',clock_timestamp()) END;
        UPDATE company_contact_import_rows SET resolution=decision, error=NULL,
            status=CASE action WHEN 'SKIP' THEN 'SKIP' WHEN 'ADD' THEN 'NEW' WHEN 'UNDO' THEN 'REVIEW' ELSE 'MATCHED' END,
            events=events||jsonb_build_array(jsonb_build_object('action',action,'actor',p_actor,'at',clock_timestamp(),'decision',decision))
            WHERE id=item.id;
        UPDATE company_contact_import_batches SET revision=revision+1 WHERE id=batch.id RETURNING * INTO batch;
        INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
            VALUES(p_actor,actor.name,actor.email,'COMPANY_CONTACTS_RESOLVED','company_contacts_import',batch.id::text,batch.file_name,
                jsonb_build_object('row',item.source_row,'decision',decision,'action',action));
    END IF;
    IF p_action='apply' THEN
        FOR item IN SELECT * FROM company_contact_import_rows WHERE batch_id=batch.id AND resolution IS NOT NULL
            AND status NOT IN ('IMPORTED','UPDATED','SKIP') ORDER BY source_row FOR UPDATE LOOP
            BEGIN
                decision := item.resolution;
                action := decision->>'action';
                values_in := decision->'values';
                old_contact := NULL;
                IF action IN ('UPDATE','KEEP') THEN
                    SELECT * INTO old_contact FROM dobco_contacts WHERE id=(decision->>'contact_id')::uuid FOR UPDATE;
                    IF NOT FOUND OR to_jsonb(old_contact) IS DISTINCT FROM decision->'contact_snapshot' THEN
                        RAISE EXCEPTION 'Contact changed after resolution; review it again' USING ERRCODE='40001';
                    END IF;
                END IF;
                IF action IN ('ADD','UPDATE') THEN
                    IF cardinality(company_contact_import_issues(values_in))>0 THEN RAISE EXCEPTION 'Invalid approved contact values'; END IF;
                    IF EXISTS(SELECT 1 FROM dobco_contacts c WHERE (action='ADD' OR c.id<>old_contact.id) AND
                        nullif(lower(btrim(c.email)),'')=lower(values_in->>'email')) THEN
                        RAISE EXCEPTION 'Email now belongs to another contact; select the existing contact or Skip';
                    END IF;
                    IF action='ADD' AND EXISTS(SELECT 1 FROM company_contact_import_rows r WHERE r.batch_id=batch.id AND r.id<>item.id
                        AND r.status IN ('IMPORTED','UPDATED') AND company_contact_import_keys(r.after_contact) && company_contact_import_keys(values_in)) THEN
                        RAISE EXCEPTION 'Another row already imported this person; select its contact or Skip';
                    END IF;
                    IF action='ADD' AND NOT coalesce((decision->>'confirm_duplicate')::boolean,false) AND EXISTS(
                        SELECT 1 FROM dobco_contacts c WHERE company_contact_import_keys(to_jsonb(c)) && company_contact_import_keys(values_in)) THEN
                        RAISE EXCEPTION 'A possible contact match appeared; review again';
                    END IF;
                END IF;
                IF action='ADD' THEN
                    INSERT INTO dobco_contacts(contact_name,email,mobile_phone)
                        VALUES(values_in->>'contact_name',values_in->>'email',values_in->>'mobile_phone') RETURNING * INTO contact;
                ELSIF action='UPDATE' THEN
                    UPDATE dobco_contacts SET contact_name=coalesce(nullif(values_in->>'contact_name',''),contact_name),
                        email=coalesce(values_in->>'email',email),mobile_phone=coalesce(values_in->>'mobile_phone',mobile_phone)
                        WHERE id=old_contact.id RETURNING * INTO contact;
                ELSIF action='KEEP' THEN contact := old_contact;
                ELSE RAISE EXCEPTION 'Invalid saved resolution'; END IF;
                UPDATE company_contact_import_rows SET status=CASE WHEN action='UPDATE' THEN 'UPDATED' ELSE 'IMPORTED' END,
                    contact_id=contact.id,before_contact=CASE WHEN action='ADD' THEN NULL ELSE to_jsonb(old_contact) END,
                    after_contact=to_jsonb(contact),error=NULL,
                    events=events||jsonb_build_array(jsonb_build_object('action','APPLIED','actor',p_actor,'at',clock_timestamp(),'contact_id',contact.id))
                    WHERE id=item.id;
                INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
                    VALUES(p_actor,actor.name,actor.email,'COMPANY_CONTACTS_'||action,'dobco_contact',contact.id::text,contact.contact_name,
                        jsonb_build_object('batch_id',batch.id,'source_row',item.source_row,'before',CASE WHEN action='ADD' THEN NULL ELSE to_jsonb(old_contact) END,'after',to_jsonb(contact)));
            EXCEPTION WHEN OTHERS THEN
                GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT,error_state=RETURNED_SQLSTATE;
                UPDATE company_contact_import_rows SET status='ERROR',resolution=NULL,error=failure,
                    events=events||jsonb_build_array(jsonb_build_object('action','ERROR','actor',p_actor,'at',clock_timestamp(),
                        'error',failure,'sqlstate',error_state,'decision',item.resolution)) WHERE id=item.id;
            END;
        END LOOP;
        UPDATE company_contact_import_batches SET revision=revision+1 WHERE id=batch.id RETURNING * INTO batch;
    END IF;
    IF p_action IN ('resolve','apply') THEN
        UPDATE company_contact_import_batches SET status=CASE
            WHEN NOT EXISTS(SELECT 1 FROM company_contact_import_rows WHERE batch_id=batch.id AND status NOT IN ('IMPORTED','UPDATED','SKIP')) THEN 'Complete'
            WHEN EXISTS(SELECT 1 FROM company_contact_import_rows WHERE batch_id=batch.id AND status IN ('IMPORTED','UPDATED')) THEN 'Partial' ELSE 'Review' END
            WHERE id=batch.id RETURNING * INTO batch;
        UPDATE import_history SET successful_rows=(SELECT count(*) FROM company_contact_import_rows WHERE batch_id=batch.id AND status IN ('IMPORTED','UPDATED')),
            failed_rows=(SELECT count(*) FROM company_contact_import_rows WHERE batch_id=batch.id AND status='ERROR') WHERE id=batch.import_history_id;
    END IF;
    SELECT jsonb_build_object('total',count(*),'imported',count(*) FILTER(WHERE status='IMPORTED'),
        'updated',count(*) FILTER(WHERE status='UPDATED'),'skipped',count(*) FILTER(WHERE status='SKIP'),
        'errors',count(*) FILTER(WHERE status='ERROR'),
        'unresolved',count(*) FILTER(WHERE resolution IS NULL AND status NOT IN ('IMPORTED','UPDATED','SKIP')),
        'ready',count(*) FILTER(WHERE resolution IS NOT NULL AND status NOT IN ('IMPORTED','UPDATED','SKIP')))
        INTO summary FROM company_contact_import_rows WHERE batch_id=batch.id;
    SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY contact_name,id),'[]') INTO contact_list
        FROM (SELECT id,contact_name,email,mobile_phone,is_active,updated_at::text AS updated_at,md5(to_jsonb(d)::text) AS version FROM dobco_contacts d) c;
    SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('issues',company_contact_import_issues(r.normalized),
        'duplicate_rows',d.matches,'exact_matches',e.matches,'suggestions',s.matches,
        'status',CASE WHEN r.status IN ('IMPORTED','UPDATED','SKIP','ERROR') OR r.resolution IS NOT NULL THEN r.status
            WHEN cardinality(company_contact_import_issues(r.normalized))>0 OR jsonb_array_length(d.matches)>0 OR jsonb_array_length(e.matches)>1 THEN 'REVIEW'
            WHEN jsonb_array_length(e.matches)=1 THEN 'MATCHED'
            WHEN jsonb_array_length(s.matches)>0 OR r.normalized->>'email' IS NULL THEN 'REVIEW' ELSE 'NEW' END) ORDER BY r.source_row),'[]')
        INTO rows_json FROM company_contact_import_rows r
        CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(o.source_row ORDER BY o.source_row),'[]') matches
            FROM company_contact_import_rows o WHERE o.batch_id=batch.id AND o.id<>r.id
                AND company_contact_import_keys(o.normalized) && company_contact_import_keys(r.normalized)) d
        CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(c),'[]') matches FROM jsonb_array_elements(contact_list) c
            WHERE nullif(lower(btrim(c->>'email')),'')=lower(r.normalized->>'email')) e
        CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(c),'[]') matches FROM jsonb_array_elements(contact_list) c
            WHERE company_contact_import_keys(c) && company_contact_import_keys(r.normalized)) s
        WHERE r.batch_id=batch.id;
    result := jsonb_build_object('batch',to_jsonb(batch)-'file_hash','rows',rows_json,'contacts',contact_list,'summary',summary);
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.company_contact_import_values(JSONB),public.company_contact_import_issues(JSONB),
    public.company_contact_import_keys(JSONB),public.company_contacts_import(TEXT,UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.company_contacts_import(TEXT,UUID,JSONB) TO service_role;
COMMIT;
