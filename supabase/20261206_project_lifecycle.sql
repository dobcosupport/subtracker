-- Proposed Project Lifecycle 1A migration. Apply only after production approval.
BEGIN;

ALTER TABLE public.projects
    ADD COLUMN closed_at TIMESTAMPTZ,
    ADD COLUMN closed_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE public.projects ADD CONSTRAINT project_closeout_metadata CHECK(
    (closed_at IS NULL AND closed_by IS NULL) OR
    (closed_at IS NOT NULL AND closed_by IS NOT NULL AND status='Inactive'));
ALTER TABLE public.contractor_projects
    ADD COLUMN original_sources TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN ended_at TIMESTAMPTZ,
    ADD COLUMN ended_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
    ADD COLUMN end_reason TEXT,
    ADD COLUMN detached_designations JSONB NOT NULL DEFAULT '{}';
UPDATE public.contractor_projects SET original_sources=ownership_sources;
ALTER TABLE public.contractor_projects ADD CONSTRAINT project_assignment_end_reason
    CHECK (end_reason IS NULL OR end_reason IN
        ('Project Closed','Work Complete','No Longer Onsite','Removed from Project','Added in Error','Other'));
ALTER TABLE public.contractor_projects ADD CONSTRAINT project_assignment_active_period CHECK(
    NOT active OR (ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL));
ALTER TABLE public.contractor_projects ADD CONSTRAINT project_assignment_designations CHECK(
    jsonb_typeof(detached_designations)='object' AND
    detached_designations-ARRAY['PROCORE','MYCOI']='{}'::jsonb);

CREATE TABLE public.project_relationship_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    assignment_id INTEGER REFERENCES public.contractor_projects(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK(action IN ('Project Closed','Assignment Ended','Designation Detached')),
    actor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    actor_name TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    details JSONB NOT NULL
);
CREATE INDEX project_relationship_events_project ON public.project_relationship_events(project_id,id);
ALTER TABLE public.project_relationship_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_relationship_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.guard_project_lifecycle() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    IF TG_TABLE_NAME='projects' THEN
        IF TG_OP='INSERT' THEN
            IF NEW.closed_at IS NOT NULL OR NEW.closed_by IS NOT NULL THEN
                RAISE EXCEPTION 'Create the project before using the administrator closeout review' USING ERRCODE='PT409';
            END IF;
            RETURN NEW;
        END IF;
        IF OLD.closed_at IS NOT NULL AND
            (NEW.status IS DISTINCT FROM OLD.status OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
                OR NEW.closed_by IS DISTINCT FROM OLD.closed_by) THEN
            RAISE EXCEPTION 'Closed project history is retained; reopening requires a separate workflow' USING ERRCODE='PT409';
        END IF;
        IF ((OLD.status<>'Inactive' AND NEW.status='Inactive') OR
            NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by IS DISTINCT FROM OLD.closed_by)
            AND (current_user IN ('anon','authenticated','service_role')
                OR current_setting('subtracker.project_closeout',true) IS DISTINCT FROM 'confirmed') THEN
            RAISE EXCEPTION 'Use the administrator Close Project review' USING ERRCODE='PT409';
        END IF;
    ELSE
        -- Merge takes dependency-table locks first; refuse instead of reversing that lock order.
        IF NOT pg_try_advisory_xact_lock(hashtext('contractor_project_ownership')) THEN
            RAISE EXCEPTION 'Project relationships are being updated; reload before continuing' USING ERRCODE='PT409';
        END IF;
        IF NEW.active AND EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND closed_at IS NOT NULL) THEN
            RAISE EXCEPTION 'Project is Closed; no new or current assignments are allowed' USING ERRCODE='PT409';
        END IF;
        IF TG_OP='UPDATE' AND OLD.ended_at IS NOT NULL AND
            (NEW.active OR NEW.contractor_id<>OLD.contractor_id OR NEW.project_id<>OLD.project_id
                OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by IS DISTINCT FROM OLD.ended_by
                OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
                OR NEW.detached_designations IS DISTINCT FROM OLD.detached_designations) THEN
            RAISE EXCEPTION 'Completed assignment periods are historical; create a new assignment period' USING ERRCODE='PT409';
        END IF;
        SELECT coalesce(array_agg(DISTINCT s ORDER BY s),'{}') INTO NEW.original_sources
        FROM unnest(NEW.ownership_sources ||
            CASE WHEN TG_OP='UPDATE' THEN OLD.original_sources ELSE '{}'::text[] END) s;
        IF TG_OP='UPDATE' THEN
            IF NOT NEW.detached_designations @> OLD.detached_designations THEN
                RAISE EXCEPTION 'Detached designations cannot be silently restored' USING ERRCODE='PT409';
            END IF;
            IF OLD.active AND NOT NEW.active AND NEW.ended_at IS NULL THEN
                NEW.ended_at:=now();
                NEW.ended_by:=nullif(current_setting('subtracker.assignment_actor',true),'')::uuid;
                -- Import/source reconciliation remains identifiable without inventing a user reason.
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_project_lifecycle() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_lifecycle_guard BEFORE INSERT OR UPDATE ON public.projects
    FOR EACH ROW EXECUTE FUNCTION public.guard_project_lifecycle();
CREATE TRIGGER assignment_lifecycle_guard BEFORE INSERT OR UPDATE ON public.contractor_projects
    FOR EACH ROW EXECUTE FUNCTION public.guard_project_lifecycle();

CREATE FUNCTION public.project_lifecycle_review(p_project INTEGER) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    WITH ids AS (SELECT DISTINCT contractor_id FROM contractor_projects WHERE project_id=p_project),
    snapshot AS (
        SELECT jsonb_build_object(
            'project',to_jsonb(p),
            'assignments',coalesce((SELECT jsonb_agg(to_jsonb(cp)||jsonb_build_object(
                'contractor_name',c.company_name,'contractor_trade',c.trade) ORDER BY cp.id)
                FROM contractor_projects cp JOIN contractors c ON c.id=cp.contractor_id
                WHERE cp.project_id=p.id),'[]'),
            'counts',jsonb_build_object(
                'Active assignments',(SELECT count(*) FROM contractor_projects WHERE project_id=p.id AND active),
                'Compliance records (associated contractors)',(SELECT count(*) FROM compliance_records WHERE contractor_id IN(SELECT * FROM ids)),
                'Documents (associated contractors)',(SELECT count(*) FROM documents WHERE contractor_id IN(SELECT * FROM ids)),
                'Contacts (associated contractors)',(SELECT count(*) FROM contractor_contacts WHERE contractor_id IN(SELECT * FROM ids)),
                'Open Follow-Ups (associated contractors)',(SELECT count(*) FROM contractor_followups WHERE contractor_id IN(SELECT * FROM ids) AND status IN('Open','Waiting Response')),
                'All Follow-Ups (associated contractors)',(SELECT count(*) FROM contractor_followups WHERE contractor_id IN(SELECT * FROM ids)),
                'Procore lineage',(SELECT count(*) FROM procore_import_lineage WHERE project_id=p.id),
                'Procore project mappings',(SELECT count(*) FROM procore_project_mappings WHERE project_id=p.id),
                'myCOI division mappings',(SELECT count(*) FROM mycoi_division_mappings WHERE project_id=p.id),
                'myCOI policies (associated contractors)',(SELECT count(*) FROM mycoi_policies WHERE contractor_id IN(SELECT * FROM ids)),
                'Project activity',(SELECT count(*) FROM activity_log WHERE project_id=p.id),
                'Communications',(SELECT count(*) FROM communication_projects WHERE project_id=p.id)),
            'contacts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'contractor_id',contractor_id,
                'contact_name',contact_name,'title_or_role',title_or_role,'is_active',is_active) ORDER BY id)
                FROM contractor_contacts WHERE contractor_id IN(SELECT * FROM ids)),'[]'),
            'followups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'contractor_id',contractor_id,
                'subject',subject,'status',status,'followup_date',followup_date) ORDER BY id)
                FROM contractor_followups WHERE contractor_id IN(SELECT * FROM ids)),'[]'),
            'procore',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'contractor_id',contractor_id,
                'import_run_id',import_run_id,'import_history_id',import_history_id,'source_row',source_row,
                'imported_at',imported_at) ORDER BY id) FROM procore_import_lineage WHERE project_id=p.id),'[]'),
            'mycoi',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM mycoi_division_mappings m WHERE project_id=p.id),'[]'),
            'events',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM project_relationship_events e WHERE project_id=p.id),'[]')
        ) AS body FROM projects p WHERE p.id=p_project
    ) SELECT body||jsonb_build_object('token',md5(body::text)) FROM snapshot;
$$;
REVOKE ALL ON FUNCTION public.project_lifecycle_review(INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_lifecycle_review(INTEGER) TO service_role;

CREATE FUNCTION public.project_lifecycle_action(
    p_project INTEGER,p_actor UUID,p_token TEXT,p_action TEXT,
    p_assignment INTEGER DEFAULT NULL,p_reason TEXT DEFAULT NULL,p_source TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE
    actor public.user_profiles;
    assignment public.contractor_projects;
    review JSONB;
    contractor INTEGER;
BEGIN
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active';
    IF actor.auth_user_id IS NULL OR NOT (actor.system_administrator OR
        (actor.role='Administrator' AND EXISTS(SELECT 1 FROM role_permissions WHERE role=actor.role
            AND module='projects' AND can_view AND can_edit))) THEN
        RAISE EXCEPTION 'Administrator Project Edit permission required' USING ERRCODE='42501';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('contractor_project_ownership')) THEN
        RAISE EXCEPTION 'Another import or relationship operation is active; reload before continuing' USING ERRCODE='PT409';
    END IF;
    PERFORM 1 FROM projects WHERE id=p_project FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project not found' USING ERRCODE='PT404'; END IF;
    review:=project_lifecycle_review(p_project);
    IF p_token IS NULL OR review->>'token' IS DISTINCT FROM p_token THEN
        RAISE EXCEPTION 'Project or relationships changed; reload the review before continuing' USING ERRCODE='PT409';
    END IF;
    IF review#>>'{project,status}'<>'Active' OR review#>>'{project,closed_at}' IS NOT NULL THEN
        RAISE EXCEPTION 'Only an Active project can be changed through this workflow' USING ERRCODE='PT409';
    END IF;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import','',true);
    IF p_action='close' AND p_assignment IS NULL AND p_reason IS NULL AND p_source IS NULL THEN
        PERFORM set_config('subtracker.project_closeout','confirmed',true);
        UPDATE projects SET status='Inactive',closed_at=now(),closed_by=p_actor,
            inactivated_at=now(),inactivated_by=actor.email,updated_at=now() WHERE id=p_project;
        UPDATE contractor_projects SET active=false,ownership_sources='{}',removed_date=greatest(current_date,assigned_date),
            ended_at=now(),ended_by=p_actor,end_reason='Project Closed'
            WHERE project_id=p_project AND active;
        INSERT INTO project_relationship_events(project_id,action,actor_id,actor_name,details)
            VALUES(p_project,'Project Closed',p_actor,actor.name,jsonb_build_object('review',review));
        FOR contractor IN SELECT DISTINCT contractor_id FROM contractor_projects WHERE project_id=p_project LOOP
            PERFORM nj_pwc_reconcile_monitoring_eligibility(contractor,NULL);
        END LOOP;
    ELSE
        SELECT * INTO assignment FROM contractor_projects
            WHERE id=p_assignment AND project_id=p_project AND active FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Active assignment not found; reload project' USING ERRCODE='PT409'; END IF;
        IF p_action='end' AND p_reason=ANY(ARRAY['Work Complete','No Longer Onsite','Removed from Project','Added in Error','Other'])
            AND p_source IS NULL THEN
            UPDATE contractor_projects SET active=false,ownership_sources='{}',
                removed_date=greatest(current_date,assigned_date),ended_at=now(),ended_by=p_actor,end_reason=p_reason
                WHERE id=assignment.id;
            INSERT INTO project_relationship_events(project_id,assignment_id,action,actor_id,actor_name,details)
                VALUES(p_project,assignment.id,'Assignment Ended',p_actor,actor.name,
                    jsonb_build_object('reason',p_reason,'original_sources',assignment.original_sources));
            PERFORM nj_pwc_reconcile_monitoring_eligibility(assignment.contractor_id,NULL);
        ELSIF p_action='detach' AND p_source IN('PROCORE','MYCOI') AND p_reason IS NULL
            AND p_source=ANY(assignment.ownership_sources) AND NOT assignment.detached_designations ? p_source THEN
            UPDATE contractor_projects SET detached_designations=detached_designations||
                jsonb_build_object(p_source,jsonb_build_object('at',now(),'by',p_actor,'name',actor.name))
                WHERE id=assignment.id;
            INSERT INTO project_relationship_events(project_id,assignment_id,action,actor_id,actor_name,details)
                VALUES(p_project,assignment.id,'Designation Detached',p_actor,actor.name,jsonb_build_object('source',p_source));
        ELSE RAISE EXCEPTION 'Invalid lifecycle action or designation already detached' USING ERRCODE='22023';
        END IF;
    END IF;
    INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
        VALUES(p_actor,actor.name,actor.email,'PROJECT_LIFECYCLE_'||upper(p_action),'project',p_project::text,
            review#>>'{project,project_name}',jsonb_build_object('assignment',p_assignment,'reason',p_reason,'source',p_source));
    RETURN project_lifecycle_review(p_project);
END $$;
REVOKE ALL ON FUNCTION public.project_lifecycle_action(INTEGER,UUID,TEXT,TEXT,INTEGER,TEXT,TEXT)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_lifecycle_action(INTEGER,UUID,TEXT,TEXT,INTEGER,TEXT,TEXT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
