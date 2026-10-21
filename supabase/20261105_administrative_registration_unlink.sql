BEGIN;

-- A retired link keeps its original record/contractor identity for historical references.
CREATE TABLE public.compliance_record_unlinks (
    record_id INTEGER PRIMARY KEY REFERENCES public.compliance_records(id) ON DELETE RESTRICT,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    compliance_type_id INTEGER NOT NULL REFERENCES public.compliance_types(id) ON DELETE RESTRICT,
    registration_key TEXT,
    reason TEXT NOT NULL CHECK (reason ~ '\S' AND length(reason) <= 2000),
    unlinked_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    unlinked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX compliance_record_unlinks_identity ON public.compliance_record_unlinks
    (contractor_id,compliance_type_id,registration_key);
ALTER TABLE public.compliance_record_unlinks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compliance_record_unlinks FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.compliance_record_unlinks TO service_role;

CREATE FUNCTION public.registration_identity_key(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT nullif(upper(regexp_replace(coalesce(value,''),'[\s-]','','g')),'');
$$;

-- Runs for every writer, including old pending approvals and worker imports.
CREATE FUNCTION public.guard_unlinked_registration() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM compliance_record_unlinks WHERE record_id=NEW.id) THEN
        IF NEW.active OR NEW.is_current OR NEW.contractor_id IS DISTINCT FROM OLD.contractor_id
            OR NEW.compliance_type_id IS DISTINCT FROM OLD.compliance_type_id
            OR NEW.registration_number IS DISTINCT FROM OLD.registration_number THEN
            RAISE EXCEPTION 'This historical registration relationship was administratively unlinked' USING ERRCODE='23514';
        END IF;
    END IF;
    IF NEW.active AND NEW.is_current AND EXISTS(
        SELECT 1 FROM compliance_types WHERE id=NEW.compliance_type_id AND compliance_name IN ('NJ PWC','NJ BRC')) THEN
        -- Same lock as the existing PWC/BRC approval/import paths and unlink RPC.
        PERFORM 1 FROM contractors WHERE id=NEW.contractor_id FOR UPDATE;
        IF EXISTS(SELECT 1 FROM compliance_record_unlinks u
            WHERE u.contractor_id=NEW.contractor_id AND u.compliance_type_id=NEW.compliance_type_id
              AND u.registration_key=registration_identity_key(NEW.registration_number)) THEN
            RAISE EXCEPTION 'Previously unlinked contractor/registration match is excluded; review a corrected registration instead'
                USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER compliance_records_guard_unlinked_registration
    BEFORE INSERT OR UPDATE ON public.compliance_records
    FOR EACH ROW EXECUTE FUNCTION public.guard_unlinked_registration();

-- Use the established updated_at DESC, id DESC selection, excluding incomplete identities.
CREATE FUNCTION public.current_contractor_registration(p_contractor INTEGER,p_type INTEGER)
RETURNS INTEGER LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
    SELECT cr.id FROM compliance_records cr JOIN compliance_types ct ON ct.id=cr.compliance_type_id
    WHERE cr.contractor_id=p_contractor AND cr.compliance_type_id=p_type AND ct.active
      AND cr.active AND cr.is_current AND nullif(btrim(cr.registration_number),'') IS NOT NULL
      AND (ct.compliance_name='NJ BRC' OR NOT ct.requires_expiration OR cr.expiration_date IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM compliance_record_unlinks u WHERE u.record_id=cr.id)
    ORDER BY cr.updated_at DESC,cr.id DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.keep_contractor_registration_in_sync()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected INTEGER; value TEXT;
BEGIN
    IF NEW.nj_pwc_number IS DISTINCT FROM OLD.nj_pwc_number THEN
        SELECT current_contractor_registration(NEW.id,id) INTO selected FROM compliance_types WHERE compliance_name='NJ PWC';
        SELECT registration_number INTO value FROM compliance_records WHERE id=selected;
        IF FOUND THEN NEW.nj_pwc_number:=value; END IF;
    END IF;
    IF NEW.nj_brc_number IS DISTINCT FROM OLD.nj_brc_number THEN
        SELECT current_contractor_registration(NEW.id,id) INTO selected FROM compliance_types WHERE compliance_name='NJ BRC';
        SELECT registration_number INTO value FROM compliance_records WHERE id=selected;
        IF FOUND THEN NEW.nj_brc_number:=value; END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.unlink_contractor_registration(
    p_contractor INTEGER,p_record INTEGER,p_compliance TEXT,p_expected_updated_at TIMESTAMPTZ,
    p_expected_identifier TEXT,p_reason TEXT,p_confirmed BOOLEAN,p_actor UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    company public.contractors;
    record public.compliance_records;
    actor public.user_profiles;
    type_id INTEGER;
    previous_value TEXT;
    resulting_value TEXT;
    selected INTEGER;
    details JSONB;
    record_company TEXT;
BEGIN
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active';
    IF NOT FOUND OR NOT (actor.system_administrator OR EXISTS(
        SELECT 1 FROM role_permissions WHERE role=actor.role AND module='compliance_sync' AND can_view AND can_manage)) THEN
        RAISE EXCEPTION 'Compliance Sync manage permission required' USING ERRCODE='42501';
    END IF;
    IF p_compliance IS NULL OR p_compliance NOT IN ('NJ PWC','NJ BRC') OR p_confirmed IS DISTINCT FROM TRUE
        OR p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason)>2000 THEN
        RAISE EXCEPTION 'Explicit confirmation and a non-blank reason of at most 2000 characters are required' USING ERRCODE='22023';
    END IF;
    SELECT id INTO type_id FROM compliance_types WHERE compliance_name=p_compliance AND active;
    IF type_id IS NULL THEN RAISE EXCEPTION 'Compliance type is unavailable' USING ERRCODE='23514'; END IF;
    SELECT * INTO company FROM contractors WHERE id=p_contractor FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Contractor not found' USING ERRCODE='P0002'; END IF;
    PERFORM 1 FROM compliance_records WHERE contractor_id=p_contractor AND compliance_type_id=type_id ORDER BY id FOR UPDATE;
    SELECT * INTO record FROM compliance_records WHERE id=p_record AND contractor_id=p_contractor AND compliance_type_id=type_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linked registration not found' USING ERRCODE='P0002'; END IF;
    previous_value:=CASE WHEN p_compliance='NJ PWC' THEN company.nj_pwc_number ELSE company.nj_brc_number END;
    SELECT coalesce(record.matched_company_name,q.matched_company_name,q.brc_evidence->>'taxpayer_name')
        INTO record_company FROM compliance_sync_review_queue q
        WHERE q.compliance_record_id=p_record AND q.status='approved' ORDER BY q.id DESC LIMIT 1;
    record_company:=coalesce(record.matched_company_name,record_company);
    IF record.updated_at IS DISTINCT FROM p_expected_updated_at OR previous_value IS DISTINCT FROM p_expected_identifier
        OR EXISTS(SELECT 1 FROM compliance_record_unlinks WHERE record_id=p_record) THEN
        RAISE EXCEPTION 'Registration changed or was already unlinked; reload before confirming' USING ERRCODE='40001';
    END IF;
    INSERT INTO compliance_record_unlinks(record_id,contractor_id,compliance_type_id,registration_key,reason,unlinked_by)
    VALUES(p_record,p_contractor,type_id,registration_identity_key(record.registration_number),btrim(p_reason),p_actor);
    UPDATE compliance_records SET active=FALSE,is_current=FALSE,updated_at=now() WHERE id=p_record;
    selected:=current_contractor_registration(p_contractor,type_id);
    SELECT registration_number INTO resulting_value FROM compliance_records WHERE id=selected;
    IF p_compliance='NJ PWC' THEN
        UPDATE contractors SET nj_pwc_number=resulting_value,updated_at=now() WHERE id=p_contractor;
    ELSE
        UPDATE contractors SET nj_brc_number=resulting_value,updated_at=now() WHERE id=p_contractor;
    END IF;
    details:=jsonb_build_object('contractor_id',p_contractor,'contractor_name',company.company_name,
        'compliance_type',p_compliance,'compliance_record_id',p_record,'identifier_removed',record.registration_number,
        'record_company_name',record_company,'previous_identifier',previous_value,'resulting_identifier',resulting_value,
        'reason',btrim(p_reason),'administrator_id',p_actor,'timestamp',clock_timestamp(),
        'missing_information',selected IS NULL,'replacement_record_id',selected,
        'another_record_selected',selected IS NOT NULL);
    INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
    VALUES(p_actor,actor.name,actor.email,'COMPLIANCE_RECORD_UNLINKED','contractor',p_contractor::text,
        company.company_name || ' ' || p_compliance,details);
    INSERT INTO activity_log(contractor_id,activity_type,notes,created_by)
    VALUES(p_contractor,'Compliance Record Unlinked',details::text,actor.email);
    RETURN details;
END;
$$;
REVOKE ALL ON FUNCTION public.registration_identity_key(TEXT),
    public.guard_unlinked_registration(),public.current_contractor_registration(INTEGER,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.unlink_contractor_registration(INTEGER,INTEGER,TEXT,TIMESTAMPTZ,TEXT,TEXT,BOOLEAN,UUID)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_contractor_registration(INTEGER,INTEGER,TEXT,TIMESTAMPTZ,TEXT,TEXT,BOOLEAN,UUID)
    TO service_role;

COMMIT;
