-- Local validation: node --test scripts\test-reports-export-prerequisites-db.mjs
-- Template configuration/read access only; management and export-data RLS stay unchanged.
BEGIN;

ALTER TABLE public.export_templates
    DROP CONSTRAINT export_templates_field_ids_check,
    ADD CONSTRAINT export_templates_field_ids_check
        CHECK (cardinality(field_ids) BETWEEN 1 AND 38);

CREATE OR REPLACE FUNCTION public.validate_export_template() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    allowed TEXT[] := ARRAY[
        'contractor_name','sage_erp_id','federal_tax_id','address_1','address_2','city','state','zip_code','county','phone','email',
        'material_vendor_only','contractor_status','nj_pwc_number','nj_pwc_effective','nj_pwc_expiration','nj_pwc_status',
        'nj_brc_number','nj_brc_name_control','nj_brc_status','ny_pwc_number','ny_pwc_effective','ny_pwc_expiration','ny_pwc_status',
        'ny_brc_number','ny_brc_status','gl_expiration','wc_expiration','project_names','project_numbers','assignment_status',
        'tiered_sub_names','tiered_sub_status','followup_date','followup_method','followup_notes','followup_status','data_warning'
    ];
    item RECORD;
BEGIN
    IF NOT NEW.field_ids <@ allowed OR array_position(NEW.field_ids, NULL) IS NOT NULL
       OR (SELECT count(DISTINCT field) FROM unnest(NEW.field_ids) field) <> cardinality(NEW.field_ids) THEN
        RAISE EXCEPTION 'Unsupported or duplicate export fields';
    END IF;
    IF NEW.sort_configuration IS NOT NULL THEN
        IF jsonb_typeof(NEW.sort_configuration) <> 'object'
           OR NOT NEW.sort_configuration ?& ARRAY['field','direction']
           OR (NEW.sort_configuration - 'field' - 'direction') <> '{}'::jsonb
           OR NEW.sort_configuration->>'field' NOT IN ('contractor_name','sage_erp_id','city','state','zip_code')
           OR NEW.sort_configuration->>'direction' NOT IN ('asc','desc')
           OR jsonb_typeof(NEW.sort_configuration->'field') <> 'string'
           OR jsonb_typeof(NEW.sort_configuration->'direction') <> 'string' THEN
            RAISE EXCEPTION 'Unsupported export sort configuration';
        END IF;
    END IF;
    IF NEW.filter_configuration IS NOT NULL THEN
        IF jsonb_typeof(NEW.filter_configuration) <> 'object' THEN
            RAISE EXCEPTION 'Unsupported export filter configuration';
        END IF;
        FOR item IN SELECT key, value FROM jsonb_each(NEW.filter_configuration) LOOP
            IF item.key NOT IN ('contractor_status','material_vendor_only','state','city','contractor_name') THEN
                RAISE EXCEPTION 'Unsupported export filter';
            ELSIF item.key = 'material_vendor_only' THEN
                IF jsonb_typeof(item.value) <> 'boolean' THEN RAISE EXCEPTION 'Invalid vendor filter'; END IF;
            ELSE
                IF jsonb_typeof(item.value) <> 'string' OR length(btrim(item.value #>> '{}')) NOT BETWEEN 1 AND 200 THEN
                    RAISE EXCEPTION 'Invalid text filter';
                END IF;
                IF item.key = 'contractor_status' AND item.value #>> '{}' NOT IN ('Active','Inactive') THEN
                    RAISE EXCEPTION 'Invalid contractor status filter';
                END IF;
            END IF;
        END LOOP;
    END IF;
    NEW.name := btrim(NEW.name);
    IF auth.uid() IS NOT NULL THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.is_system OR NEW.system_key IS NOT NULL THEN RAISE EXCEPTION 'System templates are migration-managed'; END IF;
            NEW.owner_user_id := auth.uid();
            NEW.created_by := auth.uid();
            SELECT name INTO NEW.created_by_name FROM public.user_profiles WHERE auth_user_id = auth.uid();
            NEW.created_at := now();
            NEW.revision := 1;
        ELSE
            IF OLD.is_system THEN RAISE EXCEPTION 'Duplicate system templates to customize them'; END IF;
            IF ROW(NEW.owner_user_id,NEW.created_by,NEW.created_by_name,NEW.created_at,NEW.is_system,NEW.system_key)
               IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.created_by,OLD.created_by_name,OLD.created_at,OLD.is_system,OLD.system_key) THEN
                RAISE EXCEPTION 'Template ownership and attribution cannot be changed';
            END IF;
            NEW.revision := OLD.revision + 1;
        END IF;
        IF NEW.visibility = 'shared' AND NOT public.export_template_admin() THEN
            RAISE EXCEPTION 'Only administrators can publish shared templates';
        END IF;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.export_template_can_read(
    p_owner UUID, p_visibility TEXT, p_active BOOLEAN
) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT (
        public.export_template_permission('imports', 'view')
        AND (p_owner = auth.uid() OR public.export_template_admin() OR (p_active AND p_visibility = 'shared'))
    ) OR (
        p_active AND (public.export_template_permission('dashboard', 'view')
            OR public.export_template_permission('reports', 'view'))
        AND (p_owner = auth.uid() OR p_visibility = 'shared' OR public.export_template_admin())
    );
$$;

ALTER POLICY export_preferences_select ON public.export_template_user_preferences
    USING (user_id = auth.uid()
        AND (public.export_template_permission('dashboard','view')
            OR public.export_template_permission('imports','view')
            OR public.export_template_permission('reports','view')));

CREATE OR REPLACE FUNCTION public.set_export_template_preference(p_template_id UUID, p_favorite BOOLEAN, p_default BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    template public.export_templates;
BEGIN
    IF auth.uid() IS NULL OR NOT (public.export_template_permission('dashboard','view')
        OR public.export_template_permission('imports','view')
        OR public.export_template_permission('reports','view')) THEN
        RAISE EXCEPTION 'Template access is required';
    END IF;
    IF p_favorite IS NULL OR p_default IS NULL THEN RAISE EXCEPTION 'Invalid preference'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
    SELECT * INTO template FROM public.export_templates WHERE id = p_template_id FOR SHARE;
    IF NOT FOUND OR NOT template.active OR NOT public.export_template_can_read(template.owner_user_id,template.visibility,template.active) THEN
        RAISE EXCEPTION 'Template is inactive or inaccessible';
    END IF;
    IF p_default THEN
        UPDATE public.export_template_user_preferences SET is_default = FALSE, updated_at = now()
            WHERE user_id = auth.uid() AND is_default;
    END IF;
    INSERT INTO public.export_template_user_preferences(user_id,template_id,is_favorite,is_default)
        VALUES(auth.uid(),p_template_id,p_favorite,p_default)
        ON CONFLICT(user_id,template_id) DO UPDATE
            SET is_favorite = EXCLUDED.is_favorite, is_default = EXCLUDED.is_default, updated_at = now();
END;
$$;

COMMIT;
