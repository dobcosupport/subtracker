BEGIN;

CREATE TABLE public.export_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    description TEXT CHECK (length(description) <= 2000),
    category TEXT NOT NULL DEFAULT 'contractors'
        CHECK (category IN ('contractors', 'compliance', 'insurance', 'projects', 'executive', 'personal')),
    field_ids TEXT[] NOT NULL CHECK (cardinality(field_ids) BETWEEN 1 AND 37),
    default_format TEXT NOT NULL DEFAULT 'xlsx' CHECK (default_format IN ('xlsx', 'csv')),
    default_scope TEXT NOT NULL DEFAULT 'filtered' CHECK (default_scope IN ('filtered', 'all')),
    sort_configuration JSONB,
    filter_configuration JSONB,
    configuration_version INTEGER NOT NULL DEFAULT 1 CHECK (configuration_version = 1),
    owner_user_id UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL,
    created_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revision INTEGER NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    system_key TEXT UNIQUE,
    CHECK ((is_system AND system_key IS NOT NULL AND owner_user_id IS NULL AND visibility = 'shared')
        OR (NOT is_system AND system_key IS NULL))
);
CREATE INDEX export_templates_active_category ON public.export_templates(active, category, name);
CREATE INDEX export_templates_owner ON public.export_templates(owner_user_id);

CREATE FUNCTION public.export_template_admin() RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM public.user_profiles
        WHERE auth_user_id = auth.uid() AND status = 'Active'
          AND (system_administrator OR role = 'Administrator'));
$$;
CREATE FUNCTION public.export_template_permission(p_module TEXT, p_action TEXT) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT public.export_template_admin() OR public.user_has_module_permission(p_module, p_action);
$$;
CREATE FUNCTION public.export_template_can_read(
    p_owner UUID, p_visibility TEXT, p_active BOOLEAN
) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT (
        public.export_template_permission('imports', 'view')
        AND (p_owner = auth.uid() OR public.export_template_admin() OR (p_active AND p_visibility = 'shared'))
    ) OR (
        p_active AND public.export_template_permission('dashboard', 'view')
        AND (p_owner = auth.uid() OR p_visibility = 'shared' OR public.export_template_admin())
    );
$$;

CREATE FUNCTION public.validate_export_template() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    allowed TEXT[] := ARRAY[
        'contractor_name','sage_erp_id','address_1','address_2','city','state','zip_code','county','phone','email',
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
CREATE TRIGGER export_templates_validate BEFORE INSERT OR UPDATE ON public.export_templates
    FOR EACH ROW EXECUTE FUNCTION public.validate_export_template();

ALTER TABLE public.export_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY export_templates_select ON public.export_templates FOR SELECT TO authenticated
    USING (public.export_template_can_read(owner_user_id, visibility, active));
CREATE POLICY export_templates_insert ON public.export_templates FOR INSERT TO authenticated
    WITH CHECK (public.export_template_permission('imports', 'view')
        AND public.export_template_permission('imports', 'add') AND owner_user_id = auth.uid()
        AND NOT is_system AND system_key IS NULL
        AND (visibility = 'private' OR public.export_template_admin()));
CREATE POLICY export_templates_update ON public.export_templates FOR UPDATE TO authenticated
    USING (NOT is_system AND public.export_template_permission('imports', 'view')
        AND public.export_template_permission('imports', 'edit')
        AND (owner_user_id = auth.uid() OR public.export_template_admin()))
    WITH CHECK (NOT is_system AND public.export_template_permission('imports', 'view')
        AND public.export_template_permission('imports', 'edit')
        AND (owner_user_id = auth.uid() OR public.export_template_admin())
        AND (visibility = 'private' OR public.export_template_admin()));
CREATE POLICY export_templates_delete ON public.export_templates FOR DELETE TO authenticated
    USING (NOT is_system AND public.export_template_permission('imports', 'view')
        AND public.export_template_permission('imports', 'delete')
        AND (owner_user_id = auth.uid() OR public.export_template_admin()));
REVOKE ALL ON public.export_templates FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.export_templates TO authenticated;

CREATE TABLE public.export_template_user_preferences (
    user_id UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE CASCADE,
    template_id UUID NOT NULL REFERENCES public.export_templates(id) ON DELETE CASCADE,
    is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, template_id)
);
CREATE UNIQUE INDEX export_template_one_default_per_user
    ON public.export_template_user_preferences(user_id) WHERE is_default;
ALTER TABLE public.export_template_user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY export_preferences_select ON public.export_template_user_preferences FOR SELECT TO authenticated
    USING (user_id = auth.uid()
        AND (public.export_template_permission('dashboard','view') OR public.export_template_permission('imports','view')));
REVOKE ALL ON public.export_template_user_preferences FROM anon, authenticated;
GRANT SELECT ON public.export_template_user_preferences TO authenticated;

CREATE FUNCTION public.set_export_template_preference(p_template_id UUID, p_favorite BOOLEAN, p_default BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    template public.export_templates;
BEGIN
    IF auth.uid() IS NULL OR NOT (public.export_template_permission('dashboard','view') OR public.export_template_permission('imports','view')) THEN
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

REVOKE ALL ON FUNCTION public.export_template_admin(), public.export_template_permission(TEXT,TEXT),
    public.export_template_can_read(UUID,TEXT,BOOLEAN), public.validate_export_template(),
    public.set_export_template_preference(UUID,BOOLEAN,BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.export_template_admin(), public.export_template_permission(TEXT,TEXT),
    public.export_template_can_read(UUID,TEXT,BOOLEAN), public.set_export_template_preference(UUID,BOOLEAN,BOOLEAN) TO authenticated;

INSERT INTO public.export_templates(
    name,description,category,field_ids,default_format,default_scope,created_by_name,visibility,is_system,system_key
) VALUES (
    'Contractor Master Export','Company, active/current compliance, insurance expirations, and active project assignments.',
    'contractors',ARRAY[
        'contractor_name','sage_erp_id','address_1','address_2','city','state','zip_code','county','phone','email',
        'material_vendor_only','contractor_status','nj_pwc_number','nj_pwc_expiration','nj_pwc_status',
        'nj_brc_number','nj_brc_name_control','nj_brc_status','ny_pwc_number','ny_pwc_expiration','ny_pwc_status',
        'gl_expiration','wc_expiration','project_names','project_numbers','data_warning'
    ],'xlsx','all','System','shared',TRUE,'contractor-master'
),(
    'Insurance Expiration Export','General liability and workers compensation expiration dates with contractor contact information.',
    'insurance',ARRAY[
        'contractor_name','sage_erp_id','city','state','phone','email','contractor_status','gl_expiration','wc_expiration','data_warning'
    ],'xlsx','all','System','shared',TRUE,'insurance-expiration'
)
ON CONFLICT (system_key) DO NOTHING;

COMMIT;
