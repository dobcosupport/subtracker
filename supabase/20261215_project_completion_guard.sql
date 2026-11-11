-- Pending approval only. Apply with subtracker.migration_actor set to the reviewing
-- administrator's auth user UUID in this transaction when validation fixtures exist.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtext('contractor_project_ownership'));
LOCK TABLE public.projects, public.contractor_projects IN SHARE ROW EXCLUSIVE MODE;

-- This release has no legitimate prior completion to translate. Refuse schema/data
-- drift rather than recategorizing unknown production history.
DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM public.projects WHERE closed_at IS NOT NULL OR closed_by IS NOT NULL)
        OR EXISTS(SELECT 1 FROM public.project_relationship_events WHERE action='Project Closed')
        OR EXISTS(SELECT 1 FROM public.contractor_projects WHERE end_reason='Project Closed') THEN
        RAISE EXCEPTION 'Existing completion history requires review before lifecycle standardization';
    END IF;
    IF EXISTS(SELECT 1 FROM public.projects WHERE status='Cancelled') THEN
        RAISE EXCEPTION 'Existing Cancelled projects require review before lifecycle standardization';
    END IF;
    IF EXISTS(SELECT 1 FROM public.projects WHERE status IN('Inactive','Completed')) THEN
        IF (SELECT count(*) FROM public.projects WHERE status IN('Inactive','Completed'))<>3
            OR (SELECT count(*) FROM public.projects WHERE
                (id,project_number,project_name,status) IN (
                  (46,'PROCORE VALIDATION 20261023 43F5D5-MAN','PROCORE VALIDATION 20261023 43F5D5 isolated MAN','Inactive'),
                  (47,'PROCORE VALIDATION 20261023 43F5D5-COI','PROCORE VALIDATION 20261023 43F5D5 isolated COI','Inactive'),
                  (48,'PROCORE VALIDATION 20261023 43F5D5-BOTH','PROCORE VALIDATION 20261023 43F5D5 isolated BOTH','Completed')))<>3
            OR (SELECT count(*) FROM public.contractor_projects WHERE project_id IN(46,47,48) AND active)<>5
            OR (SELECT count(*) FROM public.contractor_projects cp JOIN public.contractors c ON c.id=cp.contractor_id
                WHERE cp.active AND (cp.id,cp.project_id,cp.contractor_id,c.company_name,cp.ownership_sources) IN (
                  (1375,46,532,'PROCORE VALIDATION 20261023 43F5D5 MATCH',ARRAY['MANUAL','PROCORE']),
                  (1376,47,532,'PROCORE VALIDATION 20261023 43F5D5 MATCH',ARRAY['MYCOI','PROCORE']),
                  (1377,48,532,'PROCORE VALIDATION 20261023 43F5D5 MATCH',ARRAY['MANUAL','MYCOI','PROCORE']),
                  (1378,46,533,'PROCORE VALIDATION 20261023 43F5D5 ADD',ARRAY['PROCORE']),
                  (1379,47,533,'PROCORE VALIDATION 20261023 43F5D5 ADD',ARRAY['PROCORE'])))<>5 THEN
            RAISE EXCEPTION 'Non-active validation fixtures differ from reviewed projects/assignments; stop and review';
        END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM public.contractor_projects cp JOIN public.projects p ON p.id=cp.project_id
        WHERE cp.active AND p.status<>'Active' AND p.id NOT IN(46,47,48)) THEN
        RAISE EXCEPTION 'Unexpected current assignment on a non-active project; stop and review';
    END IF;
END $$;

ALTER TABLE public.projects DROP CONSTRAINT project_closeout_metadata;
ALTER TABLE public.projects RENAME COLUMN closed_at TO completed_at;
ALTER TABLE public.projects RENAME COLUMN closed_by TO completed_by;
ALTER TABLE public.projects
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN cancelled_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE public.contractor_projects DROP CONSTRAINT project_assignment_end_reason;
ALTER TABLE public.contractor_projects ADD CONSTRAINT project_assignment_end_reason
    CHECK(end_reason IS NULL OR end_reason IN
        ('Project Completed','Project Cancelled','Work Complete','No Longer Onsite','Removed from Project','Added in Error','Other'));
ALTER TABLE public.project_relationship_events DROP CONSTRAINT project_relationship_events_action_check;
ALTER TABLE public.project_relationship_events ADD CONSTRAINT project_relationship_events_action_check
    CHECK(action IN('Project Completed','Project Cancelled','Assignment Ended','Designation Detached'));

CREATE OR REPLACE FUNCTION public.guard_project_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    IF TG_TABLE_NAME='projects' THEN
        IF TG_OP='INSERT' THEN
            IF NEW.status IN('Completed','Cancelled','Inactive') OR NEW.completed_at IS NOT NULL OR NEW.completed_by IS NOT NULL
                OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL THEN
                RAISE EXCEPTION 'Create a current project and use Complete Project or Cancel Project' USING ERRCODE='PT409';
            END IF;
            RETURN NEW;
        END IF;
        IF (OLD.completed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL) AND
            (NEW.status IS DISTINCT FROM OLD.status OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
                OR NEW.completed_by IS DISTINCT FROM OLD.completed_by OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
                OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by) THEN
            RAISE EXCEPTION 'Completed or Cancelled project history is retained; reopening requires a separate workflow' USING ERRCODE='PT409';
        END IF;
        IF NEW.status='Inactive' THEN
            RAISE EXCEPTION 'Use Complete Project; Inactive is not a project lifecycle status' USING ERRCODE='PT409';
        END IF;
        IF ((NEW.status IN('Completed','Cancelled') AND OLD.status IS DISTINCT FROM NEW.status) OR
            NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.completed_by IS DISTINCT FROM OLD.completed_by OR
            NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by)
            AND (current_user IN('anon','authenticated','service_role')
                OR current_setting('subtracker.project_completion',true) IS DISTINCT FROM 'confirmed') THEN
            RAISE EXCEPTION 'Use Complete Project or Cancel Project to end active assignments and preserve history' USING ERRCODE='PT409';
        END IF;
        IF NEW.status IN('Completed','Cancelled') AND EXISTS(SELECT 1 FROM contractor_projects WHERE project_id=NEW.id AND active) THEN
            RAISE EXCEPTION 'Project completion or cancellation must end all current assignments atomically' USING ERRCODE='PT409';
        END IF;
    ELSE
        IF NOT pg_try_advisory_xact_lock(hashtext('contractor_project_ownership')) THEN
            RAISE EXCEPTION 'Project relationships are being updated; reload before continuing' USING ERRCODE='PT409';
        END IF;
        IF NEW.active AND EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND status IN('Completed','Cancelled')) THEN
            RAISE EXCEPTION 'Project is Completed or Cancelled; no new or current assignments are allowed' USING ERRCODE='PT409';
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
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- Shared ending mechanism for completion and the one reviewed fixture correction.
-- Private: browser and service callers can only enter through the authorized action.
CREATE FUNCTION public.end_project_assignment_periods(p_project integer,p_actor uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE assignment public.contractor_projects;
BEGIN
    IF p_reason NOT IN('Project Completed','Project Cancelled') OR p_reason IS NULL THEN
        RAISE EXCEPTION 'Invalid project assignment end reason' USING ERRCODE='22023';
    END IF;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import','',true);
    FOR assignment IN SELECT * FROM contractor_projects WHERE project_id=p_project AND active ORDER BY id FOR UPDATE LOOP
        UPDATE contractor_projects SET active=false,ownership_sources='{}',
            removed_date=greatest(current_date,assigned_date),ended_at=now(),ended_by=p_actor,end_reason=p_reason
            WHERE id=assignment.id;
        INSERT INTO project_relationship_events(project_id,assignment_id,action,actor_id,actor_name,details)
            SELECT p_project,assignment.id,'Assignment Ended',p_actor,name,
                jsonb_build_object('reason',p_reason,'original_sources',assignment.original_sources)
            FROM user_profiles WHERE auth_user_id=p_actor;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.end_project_assignment_periods(integer,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.project_lifecycle_action(
    p_project integer,p_actor uuid,p_token text,p_action text,
    p_assignment integer DEFAULT NULL,p_reason text DEFAULT NULL,p_source text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE actor public.user_profiles; assignment public.contractor_projects; review jsonb; contractor integer; event_action text;
BEGIN
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active';
    IF actor.auth_user_id IS NULL OR NOT(actor.system_administrator OR
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
    IF (p_action='cancel' AND review#>>'{project,status}' NOT IN('Active','Pending','On Hold')) OR
        (p_action<>'cancel' AND review#>>'{project,status}'<>'Active') THEN
        RAISE EXCEPTION 'Completion requires an Active project; cancellation requires a current project' USING ERRCODE='PT409';
    END IF;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import','',true);
    IF p_action IN('complete','cancel') AND p_assignment IS NULL AND p_reason IS NULL AND p_source IS NULL THEN
        event_action:=CASE p_action WHEN 'complete' THEN 'Project Completed' ELSE 'Project Cancelled' END;
        PERFORM end_project_assignment_periods(p_project,p_actor,event_action);
        PERFORM set_config('subtracker.project_completion','confirmed',true);
        UPDATE projects SET
            status=CASE p_action WHEN 'complete' THEN 'Completed' ELSE 'Cancelled' END,
            completed_at=CASE WHEN p_action='complete' THEN now() END,
            completed_by=CASE WHEN p_action='complete' THEN p_actor END,
            cancelled_at=CASE WHEN p_action='cancel' THEN now() END,
            cancelled_by=CASE WHEN p_action='cancel' THEN p_actor END,
            updated_at=now() WHERE id=p_project;
        INSERT INTO project_relationship_events(project_id,action,actor_id,actor_name,details)
            VALUES(p_project,event_action,p_actor,actor.name,jsonb_build_object('review',review));
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

DO $$
DECLARE actor public.user_profiles; project public.projects; review jsonb; contractor integer;
BEGIN
    IF EXISTS(SELECT 1 FROM projects WHERE status IN('Inactive','Completed')) THEN
        SELECT * INTO actor FROM user_profiles
            WHERE auth_user_id=nullif(current_setting('subtracker.migration_actor',true),'')::uuid
                AND status='Active' AND (system_administrator OR (role='Administrator' AND
                    EXISTS(SELECT 1 FROM role_permissions WHERE role=user_profiles.role AND module='projects' AND can_view AND can_edit)));
        IF actor.auth_user_id IS NULL THEN
            RAISE EXCEPTION 'An explicit active Project Edit administrator migration actor is required';
        END IF;
        FOR project IN SELECT * FROM projects WHERE status IN('Inactive','Completed') ORDER BY id FOR UPDATE LOOP
            review:=project_lifecycle_review(project.id);
            PERFORM set_config('subtracker.project_completion','confirmed',true);
            PERFORM end_project_assignment_periods(project.id,actor.auth_user_id,'Project Completed');
            PERFORM set_config('subtracker.project_completion','confirmed',true);
            UPDATE projects SET status='Completed',completed_at=now(),completed_by=actor.auth_user_id,updated_at=now() WHERE id=project.id;
            INSERT INTO project_relationship_events(project_id,action,actor_id,actor_name,details)
                VALUES(project.id,'Project Completed',actor.auth_user_id,actor.name,
                    jsonb_build_object('reason','Reviewed development validation lifecycle correction','review',review));
            INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
                VALUES(actor.auth_user_id,actor.name,actor.email,'PROJECT_LIFECYCLE_FIXTURE_CORRECTION','project',project.id::text,
                    project.project_name,jsonb_build_object('review',review,'reason','Reviewed development validation lifecycle correction'));
            FOR contractor IN SELECT DISTINCT contractor_id FROM contractor_projects WHERE project_id=project.id LOOP
                PERFORM nj_pwc_reconcile_monitoring_eligibility(contractor,NULL);
            END LOOP;
        END LOOP;
    END IF;
END $$;
ALTER TABLE public.projects ADD CONSTRAINT project_completion_metadata CHECK(
    (status='Completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL) OR
    (status<>'Completed' AND completed_at IS NULL AND completed_by IS NULL));
ALTER TABLE public.projects ADD CONSTRAINT project_cancellation_metadata CHECK(
    (status='Cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL) OR
    (status<>'Cancelled' AND cancelled_at IS NULL AND cancelled_by IS NULL));
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check
    CHECK(status IN('Active','Completed','Pending','On Hold','Cancelled'));
NOTIFY pgrst,'reload schema';
COMMIT;
