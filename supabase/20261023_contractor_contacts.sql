BEGIN;

CREATE TABLE public.contractor_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contractor_id INTEGER NOT NULL
        REFERENCES public.contractors(id) ON DELETE RESTRICT,
    contact_name TEXT NOT NULL CHECK (contact_name ~ '[^[:space:]]'),
    title_or_role TEXT,
    email TEXT,
    mobile_phone TEXT,
    is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE,
    is_compliance_contact BOOLEAN NOT NULL DEFAULT FALSE,
    receives_compliance_email BOOLEAN NOT NULL DEFAULT FALSE,
    receives_compliance_sms BOOLEAN NOT NULL DEFAULT FALSE,
    sms_consent_recorded BOOLEAN NOT NULL DEFAULT FALSE,
    sms_consent_date DATE,
    sms_consent_source_or_note TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (is_active OR NOT is_primary_contact)
);

CREATE INDEX idx_contractor_contacts_contractor
    ON public.contractor_contacts(contractor_id);
CREATE INDEX idx_contractor_contacts_active
    ON public.contractor_contacts(contractor_id)
    WHERE is_active;
CREATE UNIQUE INDEX uq_contractor_contacts_active_primary
    ON public.contractor_contacts(contractor_id)
    WHERE is_active AND is_primary_contact;
CREATE INDEX idx_contractor_contacts_email_recipients
    ON public.contractor_contacts(contractor_id)
    WHERE is_active AND receives_compliance_email AND email IS NOT NULL;
CREATE INDEX idx_contractor_contacts_sms_recipients
    ON public.contractor_contacts(contractor_id)
    WHERE is_active AND receives_compliance_sms
      AND mobile_phone IS NOT NULL AND sms_consent_recorded;

CREATE FUNCTION public.enforce_contractor_contact_primary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.contractor_id IS DISTINCT FROM OLD.contractor_id THEN
        RAISE EXCEPTION 'A contact cannot be moved to another contractor.'
            USING ERRCODE = '23514';
    END IF;

    PERFORM 1
      FROM public.contractors
     WHERE id = NEW.contractor_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The parent contractor does not exist.'
            USING ERRCODE = '23503';
    END IF;

    NEW.contact_name := regexp_replace(NEW.contact_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
    NEW.title_or_role := NULLIF(regexp_replace(COALESCE(NEW.title_or_role, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
    NEW.email := NULLIF(regexp_replace(COALESCE(NEW.email, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
    NEW.mobile_phone := NULLIF(regexp_replace(COALESCE(NEW.mobile_phone, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
    NEW.sms_consent_source_or_note :=
        NULLIF(regexp_replace(COALESCE(NEW.sms_consent_source_or_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
    NEW.updated_at := now();

    IF NOT NEW.is_active THEN
        NEW.is_primary_contact := FALSE;
    ELSIF NEW.is_primary_contact THEN
        UPDATE public.contractor_contacts
           SET is_primary_contact = FALSE,
               updated_at = now()
         WHERE contractor_id = NEW.contractor_id
           AND is_active
           AND is_primary_contact
           AND id IS DISTINCT FROM NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_contractor_contact_primary() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER contractor_contacts_enforce_primary
    BEFORE INSERT OR UPDATE ON public.contractor_contacts
    FOR EACH ROW EXECUTE FUNCTION public.enforce_contractor_contact_primary();

CREATE FUNCTION public.save_contractor_contact(
    p_contractor_id INTEGER,
    p_contact_id UUID,
    p_values JSONB
)
RETURNS public.contractor_contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    contact_row public.contractor_contacts%ROWTYPE;
    expected_fields TEXT[] := ARRAY[
        'contact_name', 'title_or_role', 'email', 'mobile_phone',
        'is_primary_contact', 'is_compliance_contact',
        'receives_compliance_email', 'receives_compliance_sms',
        'sms_consent_recorded', 'sms_consent_date',
        'sms_consent_source_or_note', 'is_active'
    ];
BEGIN
    IF NOT public.user_has_module_permission('contractors', 'manage') THEN
        RAISE EXCEPTION 'Contractor management permission is required.'
            USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(p_values) IS DISTINCT FROM 'object'
       OR NOT (p_values ?& expected_fields)
       OR p_values - expected_fields <> '{}'::JSONB THEN
        RAISE EXCEPTION 'Contact data is incomplete or contains unsupported fields.'
            USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_values->'contact_name') IS DISTINCT FROM 'string'
       OR NULLIF(regexp_replace(p_values->>'contact_name', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NULL THEN
        RAISE EXCEPTION 'Contact Name is required.'
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM unnest(ARRAY[
              'is_primary_contact', 'is_compliance_contact',
              'receives_compliance_email', 'receives_compliance_sms',
              'sms_consent_recorded', 'is_active'
          ]) AS fields(field_name)
         WHERE jsonb_typeof(p_values->field_name) IS DISTINCT FROM 'boolean'
    ) OR EXISTS (
        SELECT 1
          FROM unnest(ARRAY[
              'title_or_role', 'email', 'mobile_phone', 'sms_consent_source_or_note'
          ]) AS fields(field_name)
         WHERE jsonb_typeof(p_values->field_name) NOT IN ('string', 'null')
    ) OR jsonb_typeof(p_values->'sms_consent_date') NOT IN ('string', 'null') THEN
        RAISE EXCEPTION 'Contact data contains invalid field types.'
            USING ERRCODE = '22023';
    END IF;

    PERFORM 1
      FROM public.contractors
     WHERE id = p_contractor_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The parent contractor does not exist.'
            USING ERRCODE = '23503';
    END IF;

    IF p_contact_id IS NOT NULL THEN
        PERFORM 1
          FROM public.contractor_contacts
         WHERE id = p_contact_id
           AND contractor_id = p_contractor_id
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Contact was not found for this contractor.'
                USING ERRCODE = 'P0002';
        END IF;
    END IF;

    IF (p_values->>'is_active')::BOOLEAN
       AND (p_values->>'is_primary_contact')::BOOLEAN THEN
        UPDATE public.contractor_contacts
           SET is_primary_contact = FALSE,
               updated_at = now()
         WHERE contractor_id = p_contractor_id
           AND is_active
           AND is_primary_contact
           AND id IS DISTINCT FROM p_contact_id;
    END IF;

    IF p_contact_id IS NULL THEN
        INSERT INTO public.contractor_contacts (
            contractor_id, contact_name, title_or_role, email, mobile_phone,
            is_primary_contact, is_compliance_contact,
            receives_compliance_email, receives_compliance_sms,
            sms_consent_recorded, sms_consent_date, sms_consent_source_or_note,
            is_active
        ) VALUES (
            p_contractor_id,
            regexp_replace(p_values->>'contact_name', '^[[:space:]]+|[[:space:]]+$', '', 'g'),
            NULLIF(regexp_replace(COALESCE(p_values->>'title_or_role', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
            NULLIF(regexp_replace(COALESCE(p_values->>'email', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
            NULLIF(regexp_replace(COALESCE(p_values->>'mobile_phone', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
            (p_values->>'is_primary_contact')::BOOLEAN AND (p_values->>'is_active')::BOOLEAN,
            (p_values->>'is_compliance_contact')::BOOLEAN,
            (p_values->>'receives_compliance_email')::BOOLEAN,
            (p_values->>'receives_compliance_sms')::BOOLEAN,
            (p_values->>'sms_consent_recorded')::BOOLEAN,
            NULLIF(p_values->>'sms_consent_date', '')::DATE,
            NULLIF(regexp_replace(COALESCE(p_values->>'sms_consent_source_or_note', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
            (p_values->>'is_active')::BOOLEAN
        ) RETURNING * INTO contact_row;
    ELSE
        UPDATE public.contractor_contacts
           SET contact_name = regexp_replace(p_values->>'contact_name', '^[[:space:]]+|[[:space:]]+$', '', 'g'),
               title_or_role = NULLIF(regexp_replace(COALESCE(p_values->>'title_or_role', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
               email = NULLIF(regexp_replace(COALESCE(p_values->>'email', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
               mobile_phone = NULLIF(regexp_replace(COALESCE(p_values->>'mobile_phone', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
               is_primary_contact = (p_values->>'is_primary_contact')::BOOLEAN
                   AND (p_values->>'is_active')::BOOLEAN,
               is_compliance_contact = (p_values->>'is_compliance_contact')::BOOLEAN,
               receives_compliance_email = (p_values->>'receives_compliance_email')::BOOLEAN,
               receives_compliance_sms = (p_values->>'receives_compliance_sms')::BOOLEAN,
               sms_consent_recorded = (p_values->>'sms_consent_recorded')::BOOLEAN,
               sms_consent_date = NULLIF(p_values->>'sms_consent_date', '')::DATE,
               sms_consent_source_or_note =
                   NULLIF(regexp_replace(COALESCE(p_values->>'sms_consent_source_or_note', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''),
               is_active = (p_values->>'is_active')::BOOLEAN
         WHERE id = p_contact_id
           AND contractor_id = p_contractor_id
         RETURNING * INTO contact_row;
    END IF;

    RETURN contact_row;
END;
$$;

REVOKE ALL ON FUNCTION public.save_contractor_contact(INTEGER, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_contractor_contact(INTEGER, UUID, JSONB) TO authenticated;

ALTER TABLE public.contractor_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contractor_contacts FROM anon;
GRANT SELECT ON public.contractor_contacts TO authenticated;

CREATE POLICY contractor_contacts_select
    ON public.contractor_contacts FOR SELECT TO authenticated
    USING (
        public.user_has_module_permission('contractors', 'view')
        AND EXISTS (
            SELECT 1
              FROM public.contractors AS contractor
             WHERE contractor.id = contractor_contacts.contractor_id
        )
    );

CREATE POLICY contractor_contacts_insert
    ON public.contractor_contacts FOR INSERT TO authenticated
    WITH CHECK (
        public.user_has_module_permission('contractors', 'manage')
        AND EXISTS (
            SELECT 1
              FROM public.contractors AS contractor
             WHERE contractor.id = contractor_contacts.contractor_id
        )
    );

CREATE POLICY contractor_contacts_update
    ON public.contractor_contacts FOR UPDATE TO authenticated
    USING (
        public.user_has_module_permission('contractors', 'manage')
        AND EXISTS (
            SELECT 1
              FROM public.contractors AS contractor
             WHERE contractor.id = contractor_contacts.contractor_id
        )
    )
    WITH CHECK (
        public.user_has_module_permission('contractors', 'manage')
        AND EXISTS (
            SELECT 1
              FROM public.contractors AS contractor
             WHERE contractor.id = contractor_contacts.contractor_id
        )
    );

-- Like the myCOI foundation, Contacts does not require a generic audit trigger.
-- The live database lacks audit_application_change(); Step 3 contact mutations
-- are not audited. Existing tables and their audit mechanisms remain unchanged.
COMMENT ON TABLE public.contractor_contacts IS
    'Contractor address book. Kept separate from legacy contractor contact fields; no database audit trigger in Step 3. Communication delivery and history are out of scope.';
COMMENT ON COLUMN public.contractor_contacts.sms_consent_recorded IS
    'Explicit SMS consent state. A mobile phone number does not imply consent.';

COMMIT;
