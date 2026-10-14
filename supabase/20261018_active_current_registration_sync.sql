-- Active/current NJ registration records are authoritative for contractor IDs.
-- Apply after the NJ BRC/PWC processing and NJ PWC retry/acceptance migrations.
BEGIN;

CREATE OR REPLACE FUNCTION public.sync_contractor_registration_from_current_record()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_compliance_name TEXT;
BEGIN
    IF NOT NEW.active OR NOT NEW.is_current THEN
        RETURN NEW;
    END IF;

    SELECT ct.compliance_name INTO v_compliance_name
    FROM public.compliance_types ct
    WHERE ct.id = NEW.compliance_type_id;

    IF v_compliance_name = 'NJ PWC' THEN
        UPDATE public.contractors c SET nj_pwc_number = NEW.registration_number, updated_at = now()
        WHERE c.id = NEW.contractor_id AND c.nj_pwc_number IS DISTINCT FROM NEW.registration_number;
    ELSIF v_compliance_name = 'NJ BRC' THEN
        UPDATE public.contractors c SET nj_brc_number = NEW.registration_number, updated_at = now()
        WHERE c.id = NEW.contractor_id AND c.nj_brc_number IS DISTINCT FROM NEW.registration_number;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.keep_contractor_registration_in_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_registration_number TEXT;
BEGIN
    IF NEW.nj_pwc_number IS DISTINCT FROM OLD.nj_pwc_number THEN
        SELECT cr.registration_number INTO v_registration_number
        FROM public.compliance_records cr
        JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
        WHERE cr.contractor_id = NEW.id AND ct.compliance_name = 'NJ PWC'
          AND cr.active AND cr.is_current
        ORDER BY cr.updated_at DESC, cr.id DESC
        LIMIT 1;
        IF FOUND THEN
            NEW.nj_pwc_number := v_registration_number;
        END IF;
    END IF;

    IF NEW.nj_brc_number IS DISTINCT FROM OLD.nj_brc_number THEN
        SELECT cr.registration_number INTO v_registration_number
        FROM public.compliance_records cr
        JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
        WHERE cr.contractor_id = NEW.id AND ct.compliance_name = 'NJ BRC'
          AND cr.active AND cr.is_current
        ORDER BY cr.updated_at DESC, cr.id DESC
        LIMIT 1;
        IF FOUND THEN
            NEW.nj_brc_number := v_registration_number;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS compliance_records_sync_contractor_registration ON public.compliance_records;
CREATE TRIGGER compliance_records_sync_contractor_registration
AFTER INSERT OR UPDATE OF contractor_id, compliance_type_id, registration_number, active, is_current
ON public.compliance_records
FOR EACH ROW
EXECUTE FUNCTION public.sync_contractor_registration_from_current_record();

DROP TRIGGER IF EXISTS contractors_keep_registration_in_sync ON public.contractors;
CREATE TRIGGER contractors_keep_registration_in_sync
BEFORE UPDATE OF nj_pwc_number, nj_brc_number
ON public.contractors
FOR EACH ROW
EXECUTE FUNCTION public.keep_contractor_registration_in_sync();

-- Repair existing card values using current records only; latest record wins if
-- legacy data contains more than one row marked active/current.
WITH current_pwc AS (
    SELECT DISTINCT ON (cr.contractor_id) cr.contractor_id, cr.registration_number
    FROM public.compliance_records cr
    JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
    WHERE ct.compliance_name = 'NJ PWC' AND cr.active AND cr.is_current
    ORDER BY cr.contractor_id, cr.updated_at DESC, cr.id DESC
)
UPDATE public.contractors c
SET nj_pwc_number = current_pwc.registration_number, updated_at = now()
FROM current_pwc
WHERE c.id = current_pwc.contractor_id
  AND c.nj_pwc_number IS DISTINCT FROM current_pwc.registration_number;

WITH current_brc AS (
    SELECT DISTINCT ON (cr.contractor_id) cr.contractor_id, cr.registration_number
    FROM public.compliance_records cr
    JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
    WHERE ct.compliance_name = 'NJ BRC' AND cr.active AND cr.is_current
    ORDER BY cr.contractor_id, cr.updated_at DESC, cr.id DESC
)
UPDATE public.contractors c
SET nj_brc_number = current_brc.registration_number, updated_at = now()
FROM current_brc
WHERE c.id = current_brc.contractor_id
  AND c.nj_brc_number IS DISTINCT FROM current_brc.registration_number;

REVOKE ALL ON FUNCTION public.sync_contractor_registration_from_current_record() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.keep_contractor_registration_in_sync() FROM PUBLIC, anon, authenticated;

COMMIT;