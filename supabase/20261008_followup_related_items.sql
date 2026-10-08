BEGIN;

ALTER TABLE public.contractor_followups
    ADD COLUMN compliance_type_id INTEGER NULL
        REFERENCES public.compliance_types(id) ON DELETE RESTRICT,
    ADD COLUMN insurance_item_key TEXT NULL,
    ADD CONSTRAINT contractor_followups_insurance_item_key_check
        CHECK (insurance_item_key IS NULL OR insurance_item_key IN
            ('certificate_of_insurance', 'general_liability', 'workers_compensation')),
    ADD CONSTRAINT contractor_followups_related_item_exclusive_check
        CHECK (compliance_type_id IS NULL OR insurance_item_key IS NULL),
    ADD CONSTRAINT contractor_followups_insurance_record_check
        CHECK (insurance_item_key IS NULL OR compliance_record_id IS NULL);

CREATE FUNCTION public.validate_followup_related_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    linked_contractor_id INTEGER;
    linked_type_id INTEGER;
BEGIN
    -- Leave unchanged legacy links usable even when their record is not visible.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.contractor_id IS NOT DISTINCT FROM OLD.contractor_id
           AND NEW.compliance_record_id IS NOT DISTINCT FROM OLD.compliance_record_id
           AND NEW.compliance_type_id IS NOT DISTINCT FROM OLD.compliance_type_id
           AND NEW.insurance_item_key IS NOT DISTINCT FROM OLD.insurance_item_key THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.compliance_record_id IS NOT NULL THEN
        IF NEW.insurance_item_key IS NOT NULL THEN
            RAISE EXCEPTION 'An insurance related item cannot link a compliance record.'
                USING ERRCODE = '23514';
        END IF;
        SELECT contractor_id, compliance_type_id
          INTO linked_contractor_id, linked_type_id
          FROM public.compliance_records
         WHERE id = NEW.compliance_record_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Selected compliance record does not exist or is not accessible.'
                USING ERRCODE = '23514';
        END IF;
        IF linked_contractor_id IS DISTINCT FROM NEW.contractor_id THEN
            RAISE EXCEPTION 'Selected compliance record belongs to a different contractor.'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.compliance_type_id IS NULL THEN
            NEW.compliance_type_id := linked_type_id;
        ELSIF NEW.compliance_type_id IS DISTINCT FROM linked_type_id THEN
            RAISE EXCEPTION 'Selected compliance record does not match the related compliance type.'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER validate_followup_related_item
    BEFORE INSERT OR UPDATE ON public.contractor_followups
    FOR EACH ROW EXECUTE FUNCTION public.validate_followup_related_item();

COMMIT;
