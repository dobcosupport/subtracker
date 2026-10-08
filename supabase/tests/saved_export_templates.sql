-- Run only against an isolated test database with the Phase 2 migration installed.
-- All fixtures and test helpers are rolled back.
BEGIN;
CREATE SCHEMA template_test;
GRANT USAGE ON SCHEMA template_test TO authenticated, anon;
CREATE FUNCTION template_test.assert(condition BOOLEAN, message TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF condition IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Assertion failed: %', message; END IF;
END;
$$;
CREATE FUNCTION template_test.reject(statement TEXT, message_pattern TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE rejected BOOLEAN := FALSE;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE message_pattern THEN RAISE; END IF;
        rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Expected rejection: %', statement; END IF;
END;
$$;

INSERT INTO public.app_roles(role) VALUES ('Template Test Owner'),('Template Test Viewer'),('Template Test Add Only'),('Template Test Admin');
INSERT INTO auth.users(id,email) VALUES
    ('00000000-0000-0000-0000-000000000101','template-owner@example.invalid'),
    ('00000000-0000-0000-0000-000000000102','template-viewer@example.invalid'),
    ('00000000-0000-0000-0000-000000000103','template-add@example.invalid'),
    ('00000000-0000-0000-0000-000000000104','template-admin@example.invalid');
INSERT INTO public.user_profiles(auth_user_id,name,email,role,status,system_administrator) VALUES
    ('00000000-0000-0000-0000-000000000101','Owner','template-owner@example.invalid','Template Test Owner','Active',FALSE),
    ('00000000-0000-0000-0000-000000000102','Viewer','template-viewer@example.invalid','Template Test Viewer','Active',FALSE),
    ('00000000-0000-0000-0000-000000000103','Add Only','template-add@example.invalid','Template Test Add Only','Active',FALSE),
    ('00000000-0000-0000-0000-000000000104','Admin','template-admin@example.invalid','Template Test Admin','Active',TRUE);
INSERT INTO public.role_permissions(role,module,can_view,can_manage,can_add,can_edit,can_delete) VALUES
    ('Template Test Owner','imports',TRUE,TRUE,TRUE,TRUE,TRUE),
    ('Template Test Owner','dashboard',TRUE,FALSE,FALSE,FALSE,FALSE),
    ('Template Test Viewer','dashboard',TRUE,FALSE,FALSE,FALSE,FALSE),
    ('Template Test Add Only','imports',TRUE,TRUE,TRUE,FALSE,FALSE);

SELECT template_test.assert((SELECT count(*) = 2 FROM public.export_templates WHERE is_system), 'Two system templates');
SELECT template_test.assert((SELECT category = 'insurance' AND cardinality(field_ids) = 10 AND 'data_warning' = ANY(field_ids) FROM public.export_templates WHERE system_key='insurance-expiration'), 'Insurance seed');
SELECT template_test.assert((SELECT category = 'contractors' AND cardinality(field_ids) = 26 AND default_scope='all' FROM public.export_templates WHERE system_key='contractor-master'), 'Contractor seed');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000101',TRUE);
INSERT INTO public.export_templates(id,name,category,field_ids,owner_user_id,created_by_name) VALUES
    ('00000000-0000-0000-0000-000000000201','Owner template','personal',ARRAY['data_warning','contractor_name'],
     '00000000-0000-0000-0000-000000000102','Spoofed creator');
SELECT template_test.assert((SELECT owner_user_id=auth.uid() AND created_by=auth.uid() AND created_by_name='Owner' FROM public.export_templates WHERE id='00000000-0000-0000-0000-000000000201'), 'Creator and owner are server-assigned');
UPDATE public.export_templates SET name='Owner revised',category='insurance' WHERE id='00000000-0000-0000-0000-000000000201' AND revision=1;
SELECT template_test.assert((SELECT revision=2 AND category='insurance' FROM public.export_templates WHERE id='00000000-0000-0000-0000-000000000201'), 'Category update increments revision');
WITH changed AS (UPDATE public.export_templates SET name='Stale' WHERE id='00000000-0000-0000-0000-000000000201' AND revision=1 RETURNING id)
SELECT template_test.assert((SELECT count(*)=0 FROM changed), 'Stale update prevented');
SELECT template_test.reject($q$UPDATE public.export_templates SET owner_user_id='00000000-0000-0000-0000-000000000102' WHERE id='00000000-0000-0000-0000-000000000201'$q$, '%ownership%');
SELECT template_test.reject($q$UPDATE public.export_templates SET visibility='shared' WHERE id='00000000-0000-0000-0000-000000000201'$q$, '%administrators%');
SELECT template_test.reject($q$INSERT INTO public.export_templates(name,category,field_ids) VALUES('Bad','unknown',ARRAY['contractor_name'])$q$, '%check constraint%');
SELECT template_test.reject($q$INSERT INTO public.export_templates(name,field_ids) VALUES('Bad',ARRAY['ein'])$q$, '%Unsupported%');
SELECT template_test.reject($q$INSERT INTO public.export_templates(name,field_ids) VALUES('Bad',ARRAY['contractor_name','contractor_name'])$q$, '%duplicate%');
SELECT template_test.reject($q$INSERT INTO public.export_templates(name,field_ids,sort_configuration) VALUES('Bad',ARRAY['contractor_name'],'{"field": "sql", "direction": "asc"}')$q$, '%sort%');
SELECT template_test.reject($q$INSERT INTO public.export_templates(name,field_ids,filter_configuration) VALUES('Bad',ARRAY['contractor_name'],'{"sql": "select *"}')$q$, '%filter%');
SELECT template_test.reject($q$INSERT INTO public.export_templates(name,field_ids,is_system,system_key,visibility) VALUES('Fake system',ARRAY['contractor_name'],TRUE,'fake','shared')$q$, '%migration-managed%');
WITH changed AS (UPDATE public.export_templates SET name='Changed system' WHERE is_system RETURNING id)
SELECT template_test.assert((SELECT count(*)=0 FROM changed), 'System update denied');
WITH changed AS (DELETE FROM public.export_templates WHERE is_system RETURNING id)
SELECT template_test.assert((SELECT count(*)=0 FROM changed), 'System deletion denied');
SELECT public.set_export_template_preference('00000000-0000-0000-0000-000000000201',TRUE,TRUE);
SELECT public.set_export_template_preference((SELECT id FROM public.export_templates WHERE system_key='insurance-expiration'),FALSE,TRUE);
SELECT template_test.assert((SELECT count(*)=1 FROM public.export_template_user_preferences WHERE is_default), 'Only one personal default');
SELECT template_test.reject($q$INSERT INTO public.export_template_user_preferences(user_id,template_id) VALUES(auth.uid(),'00000000-0000-0000-0000-000000000201')$q$, '%permission denied%');

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000102',TRUE);
SELECT template_test.assert((SELECT count(*)=2 FROM public.export_templates), 'Dashboard-only viewer sees system templates but not private template');
SELECT template_test.assert((SELECT count(*)=0 FROM public.export_template_user_preferences), 'Other user preferences invisible');
SELECT template_test.reject($q$INSERT INTO public.export_templates(name,field_ids) VALUES('Denied',ARRAY['contractor_name'])$q$, '%row-level security%');
WITH changed AS (UPDATE public.export_templates SET category='projects' WHERE id='00000000-0000-0000-0000-000000000201' RETURNING id)
SELECT template_test.assert((SELECT count(*)=0 FROM changed), 'Other owner category change denied');
SELECT template_test.reject($q$SELECT public.set_export_template_preference('00000000-0000-0000-0000-000000000201',TRUE,TRUE)$q$, '%inaccessible%');

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000103',TRUE);
INSERT INTO public.export_templates(id,name,field_ids) VALUES('00000000-0000-0000-0000-000000000203','Add only',ARRAY['contractor_name']);
WITH changed AS (UPDATE public.export_templates SET name='Not allowed' WHERE id='00000000-0000-0000-0000-000000000203' RETURNING id)
SELECT template_test.assert((SELECT count(*)=0 FROM changed), 'Add does not grant edit');
WITH changed AS (DELETE FROM public.export_templates WHERE id='00000000-0000-0000-0000-000000000203' RETURNING id)
SELECT template_test.assert((SELECT count(*)=0 FROM changed), 'Add does not grant delete');

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000104',TRUE);
INSERT INTO public.export_templates(id,name,category,field_ids,visibility) VALUES
    ('00000000-0000-0000-0000-000000000204','Shared executive','executive',ARRAY['contractor_name','data_warning'],'shared');
UPDATE public.export_templates SET active=FALSE WHERE id='00000000-0000-0000-0000-000000000203';
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000102',TRUE);
SELECT template_test.assert((SELECT count(*)=3 FROM public.export_templates), 'Shared template visible to Dashboard viewer');
SELECT public.set_export_template_preference('00000000-0000-0000-0000-000000000204',TRUE,TRUE);
SELECT template_test.assert((SELECT count(*)=1 FROM public.export_template_user_preferences), 'Viewer can set personal preferences');
WITH changed AS (UPDATE public.export_templates SET name='Shared change' WHERE id='00000000-0000-0000-0000-000000000204' RETURNING id)
SELECT template_test.assert((SELECT count(*)=0 FROM changed), 'Sharing grants no edit');

RESET ROLE;
UPDATE public.user_profiles SET status='Inactive' WHERE auth_user_id='00000000-0000-0000-0000-000000000102';
SET ROLE authenticated;
SELECT template_test.assert((SELECT count(*)=0 FROM public.export_templates), 'Inactive users cannot read templates');
SELECT template_test.reject($q$SELECT public.set_export_template_preference('00000000-0000-0000-0000-000000000204',TRUE,TRUE)$q$, '%access%');
SET ROLE anon;
SELECT template_test.reject('SELECT * FROM public.export_templates','%permission denied%');
SELECT template_test.reject('SELECT * FROM public.export_template_user_preferences','%permission denied%');
SELECT template_test.reject($q$SELECT public.set_export_template_preference('00000000-0000-0000-0000-000000000204',TRUE,TRUE)$q$,'%permission denied%');
RESET ROLE;
ROLLBACK;
