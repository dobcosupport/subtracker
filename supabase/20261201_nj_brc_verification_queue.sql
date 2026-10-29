-- Durable administrative NJ BRC verification manifests. This migration adds
-- no search/claim/worker behavior; queue rows remain derived from live records.
BEGIN;

CREATE OR REPLACE VIEW public.nj_brc_verification_queue
WITH (security_invoker = true)
AS
WITH current_records AS (
    SELECT
        cr.contractor_id,
        count(*)::INTEGER AS current_record_count,
        count(*) FILTER (WHERE nullif(trim(cr.registration_number), '') IS NOT NULL)::INTEGER
            AS current_nonblank_record_count,
        count(DISTINCT nullif(trim(cr.registration_number), '')) FILTER (
            WHERE nullif(trim(cr.registration_number), '') IS NOT NULL
        )::INTEGER AS current_distinct_number_count,
        (array_agg(cr.id ORDER BY cr.updated_at DESC, cr.id DESC))[1] AS current_record_id,
        (array_agg(nullif(trim(cr.registration_number), '')
            ORDER BY cr.updated_at DESC, cr.id DESC))[1] AS current_record_number,
        (array_agg(nullif(trim(cr.registration_number), '')
            ORDER BY cr.updated_at DESC, cr.id DESC) FILTER (
                WHERE nullif(trim(cr.registration_number), '') IS NOT NULL
            ))[1] AS current_nonblank_record_number,
        (array_agg(cr.verified_date ORDER BY cr.updated_at DESC, cr.id DESC))[1] AS verified_date,
        (array_agg(nullif(trim(cr.verified_by), '')
            ORDER BY cr.updated_at DESC, cr.id DESC))[1] AS verified_by,
        (array_agg(nullif(trim(cr.verification_source), '')
            ORDER BY cr.updated_at DESC, cr.id DESC))[1] AS verification_source
    FROM public.compliance_records cr
    JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
    WHERE ct.compliance_name = 'NJ BRC'
      AND ct.active IS TRUE
      AND cr.active IS TRUE
      AND cr.is_current IS TRUE
    GROUP BY cr.contractor_id
),
latest_requests AS (
    SELECT DISTINCT ON (r.contractor_id)
        r.contractor_id,
        r.id,
        r.status,
        r.result_type,
        r.review_queue_id,
        coalesce(r.completed_at, r.processing_started_at, r.claimed_at, r.created_at) AS attempted_at
    FROM public.nj_brc_search_requests r
    ORDER BY r.contractor_id, r.created_at DESC, r.updated_at DESC, r.id DESC
),
request_activity AS (
    SELECT
        r.contractor_id,
        bool_or(r.status IN ('pending', 'claimed', 'processing',
            'human_verification_required', 'review_required')) AS has_active_request
    FROM public.nj_brc_search_requests r
    GROUP BY r.contractor_id
),
review_activity AS (
    SELECT
        q.contractor_id,
        bool_or(q.status = 'pending') AS has_pending_review
    FROM public.compliance_sync_review_queue q
    WHERE q.compliance_name = 'NJ BRC'
    GROUP BY q.contractor_id
),
latest_reviews AS (
    SELECT DISTINCT ON (q.contractor_id)
        q.contractor_id,
        q.status
    FROM public.compliance_sync_review_queue q
    WHERE q.compliance_name = 'NJ BRC'
    ORDER BY q.contractor_id, q.created_at DESC, q.id DESC
),
queue_inputs AS (
    SELECT
        c.id AS contractor_id,
        c.company_name,
        nullif(trim(c.nj_brc_number), '') AS master_brc_number,
        nullif(trim(c.brc_name_control), '') AS name_control,
        c.federal_tax_id,
        cr.current_record_count,
        cr.current_nonblank_record_count,
        cr.current_distinct_number_count,
        cr.current_record_number,
        cr.current_nonblank_record_number,
        cr.verified_date,
        cr.verified_by,
        cr.verification_source,
        r.status AS request_status,
        r.result_type,
        r.attempted_at AS last_attempt_at,
        CASE WHEN coalesce(ra.has_pending_review, FALSE)
            THEN 'pending' ELSE latest_review.status END AS review_status,
        coalesce(request_activity.has_active_request, FALSE) AS has_active_request,
        coalesce(ra.has_pending_review, FALSE) AS has_pending_review
    FROM public.contractors c
    LEFT JOIN current_records cr ON cr.contractor_id = c.id
    LEFT JOIN latest_requests r ON r.contractor_id = c.id
    LEFT JOIN request_activity ON request_activity.contractor_id = c.id
    LEFT JOIN review_activity ra ON ra.contractor_id = c.id
    LEFT JOIN latest_reviews latest_review ON latest_review.contractor_id = c.id
    WHERE c.active IS TRUE
),
classified AS (
    SELECT
        q.*,
        CASE
            WHEN q.name_control IS NULL THEN 'missing'
            WHEN q.name_control !~ '^[A-Za-z0-9&-]{4}$' THEN 'invalid'
            ELSE 'valid'
        END AS name_control_status,
        CASE
            WHEN nullif(trim(q.federal_tax_id), '') IS NULL THEN 'missing'
            WHEN q.federal_tax_id !~ '^[0-9[:space:]().-]+$'
              OR length(regexp_replace(coalesce(q.federal_tax_id, ''), '[^0-9]', '', 'g')) <> 9
                THEN 'invalid'
            ELSE 'valid'
        END AS fein_status,
        (
            coalesce(q.current_record_count, 0) > 1
            OR (
                q.master_brc_number IS NOT NULL
                AND q.current_record_number IS NOT NULL
                AND q.master_brc_number IS DISTINCT FROM q.current_record_number
            )
            OR coalesce(q.current_distinct_number_count, 0) > 1
        ) AS has_current_conflict,
        (
            q.current_record_number IS NOT NULL
            AND q.verified_date IS NOT NULL
            AND q.verified_by IS NOT NULL
            AND q.verification_source IS NOT NULL
        ) AS has_verification_provenance
    FROM queue_inputs q
),
bucketed AS (
    SELECT
        c.*,
        CASE
            WHEN c.has_current_conflict
              OR c.has_active_request
              OR c.has_pending_review
              OR c.request_status IN ('pending', 'claimed', 'processing',
                    'human_verification_required', 'review_required',
                    'invalid_input', 'identity_mismatch', 'ambiguous_result')
              OR c.result_type IN ('invalid_input', 'identity_mismatch', 'ambiguous_result')
              OR c.review_status IN ('pending', 'rejected')
                THEN 'needs_review'
            WHEN c.current_record_number IS NOT NULL AND c.has_verification_provenance
                THEN 'verified'
            WHEN c.master_brc_number IS NOT NULL OR c.current_record_number IS NOT NULL
                THEN 'existing_brc'
            WHEN nullif(trim(c.company_name), '') IS NULL
              OR c.name_control_status <> 'valid'
              OR c.fein_status <> 'valid'
                THEN 'missing_information'
            WHEN c.request_status = 'no_match' OR c.result_type = 'no_match'
                THEN 'no_result'
            WHEN c.request_status IN ('website_error', 'failed')
              OR c.result_type IN ('website_error', 'failed')
                THEN 'failed'
            ELSE 'ready'
        END AS bucket,
        CASE
            WHEN coalesce(c.current_nonblank_record_count, 0) > 0 THEN 'Active'
            WHEN coalesce(c.current_record_count, 0) > 0 THEN 'Missing Information'
            WHEN c.master_brc_number IS NOT NULL THEN 'Master only'
            ELSE 'Missing Information'
        END AS compliance_state,
        coalesce(c.current_record_number, c.current_nonblank_record_number,
            c.master_brc_number) AS brc_number,
        coalesce(c.result_type, c.request_status) AS last_result
    FROM classified c
)
SELECT
    contractor_id,
    company_name,
    brc_number,
    name_control_status,
    fein_status,
    compliance_state,
    request_status,
    review_status,
    last_attempt_at,
    last_result,
    bucket,
    array_remove(ARRAY[
        CASE WHEN has_current_conflict
            THEN 'Current NJ BRC data conflicts with the contractor master or has multiple current records.' END,
        CASE WHEN request_status IN ('pending', 'claimed', 'processing',
                'human_verification_required', 'review_required')
            THEN 'The latest NJ BRC request is pending, in progress, or awaiting review.' END,
        CASE WHEN result_type IN ('identity_mismatch', 'ambiguous_result')
            THEN 'The latest NJ BRC result requires identity or ambiguity review.' END,
        CASE WHEN request_status = 'invalid_input' OR result_type = 'invalid_input'
            THEN 'The latest NJ BRC request used invalid saved lookup input and requires review.' END,
        CASE WHEN review_status = 'pending'
            THEN 'The latest NJ BRC review is pending.' END,
        CASE WHEN review_status = 'rejected'
            THEN 'The latest NJ BRC review was rejected.' END,
        CASE WHEN bucket = 'verified'
            THEN 'A current NJ BRC record has verification date, verifier, and source metadata.' END,
        CASE WHEN bucket = 'existing_brc'
            THEN 'A nonblank BRC number exists without complete current verification provenance.' END,
        CASE WHEN nullif(trim(company_name), '') IS NULL
            THEN 'The saved company name is missing.' END,
        CASE WHEN name_control_status = 'missing'
            THEN 'The saved BRC Name Control is missing.' END,
        CASE WHEN name_control_status = 'invalid'
            THEN 'The saved BRC Name Control must be exactly four supported characters.' END,
        CASE WHEN fein_status = 'missing'
            THEN 'The saved FEIN is missing.' END,
        CASE WHEN fein_status = 'invalid'
            THEN 'The saved FEIN is invalid for NJ BRC lookup.' END,
        CASE WHEN bucket = 'no_result'
            THEN 'The latest NJ BRC search found no result.' END,
        CASE WHEN bucket = 'failed'
            THEN 'The latest NJ BRC attempt failed.' END,
        CASE WHEN bucket = 'ready'
            THEN 'Saved company identity fields are valid and no existing BRC or unresolved request was found.' END
    ]::TEXT[], NULL) AS reasons
FROM bucketed;

REVOKE ALL ON public.nj_brc_verification_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.nj_brc_verification_queue TO service_role;

CREATE FUNCTION public.get_nj_brc_verification_queue(
    p_bucket TEXT,
    p_search TEXT,
    p_page INTEGER,
    p_page_size INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    result JSONB;
BEGIN
    IF p_bucket IS NULL OR p_bucket NOT IN (
        'all', 'ready', 'existing_brc', 'missing_information', 'needs_review',
        'verified', 'no_result', 'failed'
    ) THEN
        RAISE EXCEPTION 'Unsupported NJ BRC queue bucket.' USING ERRCODE = '22023';
    END IF;
    IF p_page IS NULL OR p_page < 1 OR p_page > 100000
       OR p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 100 THEN
        RAISE EXCEPTION 'Invalid NJ BRC queue pagination.' USING ERRCODE = '22023';
    END IF;
    IF length(coalesce(p_search, '')) > 100 THEN
        RAISE EXCEPTION 'NJ BRC queue search is too long.' USING ERRCODE = '22023';
    END IF;

    WITH queue AS MATERIALIZED (
        SELECT *
        FROM public.nj_brc_verification_queue
    ),
    bucket_counts AS (
        SELECT
            count(*)::BIGINT AS all_count,
            count(*) FILTER (WHERE bucket = 'ready')::BIGINT AS ready,
            count(*) FILTER (WHERE bucket = 'existing_brc')::BIGINT AS existing_brc,
            count(*) FILTER (WHERE bucket = 'missing_information')::BIGINT AS missing_information,
            count(*) FILTER (WHERE bucket = 'needs_review')::BIGINT AS needs_review,
            count(*) FILTER (WHERE bucket = 'verified')::BIGINT AS verified,
            count(*) FILTER (WHERE bucket = 'no_result')::BIGINT AS no_result,
            count(*) FILTER (WHERE bucket = 'failed')::BIGINT AS failed
        FROM queue
    ),
    filtered AS (
        SELECT q.*
        FROM queue q
        WHERE (p_bucket = 'all' OR q.bucket = p_bucket)
          AND (
              nullif(trim(p_search), '') IS NULL
              OR strpos(lower(coalesce(q.company_name, '')), lower(trim(p_search))) > 0
              OR strpos(lower(coalesce(q.brc_number, '')), lower(trim(p_search))) > 0
              OR (trim(p_search) ~ '^[0-9]+$' AND q.contractor_id::TEXT = trim(p_search))
          )
    ),
    page_rows AS (
        SELECT
            contractor_id, company_name, brc_number, name_control_status, fein_status,
            compliance_state, request_status, review_status, last_attempt_at, last_result,
            bucket, reasons
        FROM filtered
        ORDER BY company_name ASC, contractor_id ASC
        OFFSET (p_page - 1) * p_page_size
        LIMIT p_page_size
    )
    SELECT jsonb_build_object(
        'rows', coalesce((
            SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY page_rows.company_name, page_rows.contractor_id)
            FROM page_rows
        ), '[]'::JSONB),
        'counts', jsonb_build_object(
            'all', bucket_counts.all_count,
            'ready', bucket_counts.ready,
            'existing_brc', bucket_counts.existing_brc,
            'missing_information', bucket_counts.missing_information,
            'needs_review', bucket_counts.needs_review,
            'verified', bucket_counts.verified,
            'no_result', bucket_counts.no_result,
            'failed', bucket_counts.failed
        ),
        'total_filtered', (SELECT count(*)::BIGINT FROM filtered),
        'page', p_page,
        'page_size', p_page_size
    )
    INTO result
    FROM bucket_counts;
    RETURN result;
END;
$$;

CREATE TABLE public.nj_brc_verification_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'prepared'
        CHECK (status IN ('prepared', 'paused', 'stopped')),
    member_count INTEGER NOT NULL CHECK (member_count > 0),
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    updated_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.nj_brc_verification_session_members (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES public.nj_brc_verification_sessions(id) ON DELETE RESTRICT,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    request_id UUID,
    state TEXT NOT NULL DEFAULT 'prepared'
        CHECK (state IN ('prepared', 'completed', 'skipped')),
    completed_at TIMESTAMPTZ,
    skipped_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT nj_brc_verification_session_members_unique_contractor
        UNIQUE (session_id, contractor_id),
    CONSTRAINT nj_brc_verification_session_members_unique_ordinal
        UNIQUE (session_id, ordinal),
    CONSTRAINT nj_brc_verification_session_member_outcome_state
        CHECK (
            (state = 'prepared' AND completed_at IS NULL AND skipped_at IS NULL)
            OR (state = 'completed' AND completed_at IS NOT NULL AND skipped_at IS NULL)
            OR (state = 'skipped' AND skipped_at IS NOT NULL AND completed_at IS NULL)
        )
);

CREATE UNIQUE INDEX nj_brc_search_requests_id_contractor
    ON public.nj_brc_search_requests(id, contractor_id);
ALTER TABLE public.nj_brc_verification_session_members
    ADD CONSTRAINT nj_brc_verification_session_member_request_contractor_fk
    FOREIGN KEY (request_id, contractor_id)
    REFERENCES public.nj_brc_search_requests(id, contractor_id)
    ON DELETE RESTRICT;

CREATE TABLE public.nj_brc_verification_session_events (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES public.nj_brc_verification_sessions(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN ('prepared', 'pause', 'resume', 'stop')),
    from_status TEXT CHECK (from_status IS NULL OR from_status IN ('prepared', 'paused', 'stopped')),
    to_status TEXT NOT NULL CHECK (to_status IN ('prepared', 'paused', 'stopped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX nj_brc_verification_sessions_created
    ON public.nj_brc_verification_sessions(created_at DESC);
CREATE INDEX nj_brc_verification_session_members_contractor
    ON public.nj_brc_verification_session_members(contractor_id);
CREATE INDEX nj_brc_verification_session_events_session
    ON public.nj_brc_verification_session_events(session_id, created_at);

CREATE FUNCTION public.get_nj_brc_verification_session(p_session_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', s.id,
        'status', s.status,
        'created_at', s.created_at,
        'updated_at', s.updated_at,
        'member_count', s.member_count,
        'members', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'contractor_id', m.contractor_id,
                'ordinal', m.ordinal,
                'request_id', m.request_id,
                'state', m.state,
                'completed_at', m.completed_at,
                'skipped_at', m.skipped_at,
                'company_name', c.company_name
            ) ORDER BY m.ordinal)
            FROM public.nj_brc_verification_session_members m
            JOIN public.contractors c ON c.id = m.contractor_id
            WHERE m.session_id = s.id
        ), '[]'::JSONB)
    )
    FROM public.nj_brc_verification_sessions s
    WHERE s.id = p_session_id;
$$;

ALTER TABLE public.nj_brc_verification_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nj_brc_verification_session_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nj_brc_verification_session_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nj_brc_verification_sessions,
    public.nj_brc_verification_session_members,
    public.nj_brc_verification_session_events
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nj_brc_verification_sessions,
    public.nj_brc_verification_session_members,
    public.nj_brc_verification_session_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.nj_brc_verification_session_members_id_seq,
    public.nj_brc_verification_session_events_id_seq TO service_role;

CREATE FUNCTION public.create_nj_brc_verification_session(p_contractor_ids INTEGER[])
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    actor public.user_profiles%ROWTYPE;
    new_session_id UUID;
    invalid_count INTEGER;
BEGIN
    IF NOT coalesce(public.user_has_module_permission('compliance_sync', 'manage'), FALSE) THEN
        RAISE EXCEPTION 'Compliance Sync manage permission required' USING ERRCODE = '42501';
    END IF;
    SELECT profile.* INTO actor
    FROM public.user_profiles profile
    WHERE profile.auth_user_id = auth.uid() AND profile.status = 'Active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active user profile required' USING ERRCODE = '42501';
    END IF;
    IF p_contractor_ids IS NULL OR cardinality(p_contractor_ids) < 1
       OR cardinality(p_contractor_ids) > 5000
       OR array_position(p_contractor_ids, NULL) IS NOT NULL
       OR cardinality(ARRAY(SELECT DISTINCT unnest(p_contractor_ids))) <> cardinality(p_contractor_ids) THEN
        RAISE EXCEPTION 'Select between 1 and 5000 unique contractors.' USING ERRCODE = '22023';
    END IF;

    SELECT count(*) INTO invalid_count
    FROM unnest(p_contractor_ids) selected(contractor_id)
    LEFT JOIN public.nj_brc_verification_queue q
      ON q.contractor_id = selected.contractor_id
    WHERE q.contractor_id IS NULL OR q.bucket <> 'ready';
    IF invalid_count > 0 THEN
        RAISE EXCEPTION 'Every selected contractor must still be Ready. Refresh the queue and try again.'
            USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.nj_brc_verification_sessions(status, member_count, created_by, updated_by)
    VALUES ('prepared', cardinality(p_contractor_ids), actor.auth_user_id, actor.auth_user_id)
    RETURNING id INTO new_session_id;

    INSERT INTO public.nj_brc_verification_session_members(session_id, contractor_id, ordinal)
    SELECT new_session_id, selected.contractor_id, selected.ordinality::INTEGER
    FROM unnest(p_contractor_ids) WITH ORDINALITY selected(contractor_id, ordinality);

    INSERT INTO public.nj_brc_verification_session_events(
        session_id, actor_id, action, from_status, to_status
    ) VALUES (new_session_id, actor.auth_user_id, 'prepared', NULL, 'prepared');

    INSERT INTO public.administration_audit_log(
        user_id, user_name, user_email, action, object_type, object_id, object_label, details
    ) VALUES (
        actor.auth_user_id, actor.name, actor.email, 'PREPARE',
        'nj_brc_verification_sessions', new_session_id::TEXT, 'NJ BRC verification session',
        jsonb_build_object('member_count', cardinality(p_contractor_ids), 'status', 'prepared')
    );
    RETURN new_session_id;
END;
$$;

CREATE FUNCTION public.set_nj_brc_verification_session_state(
    p_session_id UUID,
    p_action TEXT
)
RETURNS TABLE(id UUID, status TEXT, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    actor public.user_profiles%ROWTYPE;
    session_row public.nj_brc_verification_sessions%ROWTYPE;
    next_status TEXT;
BEGIN
    IF NOT coalesce(public.user_has_module_permission('compliance_sync', 'manage'), FALSE) THEN
        RAISE EXCEPTION 'Compliance Sync manage permission required' USING ERRCODE = '42501';
    END IF;
    SELECT profile.* INTO actor
    FROM public.user_profiles profile
    WHERE profile.auth_user_id = auth.uid() AND profile.status = 'Active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active user profile required' USING ERRCODE = '42501';
    END IF;
    IF p_action NOT IN ('pause', 'resume', 'stop') THEN
        RAISE EXCEPTION 'Action must be pause, resume, or stop.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO session_row
    FROM public.nj_brc_verification_sessions s
    WHERE s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ BRC verification session not found.' USING ERRCODE = 'P0002';
    END IF;

    next_status := CASE p_action
        WHEN 'pause' THEN 'paused'
        WHEN 'resume' THEN 'prepared'
        WHEN 'stop' THEN 'stopped'
    END;
    IF (p_action = 'pause' AND session_row.status <> 'prepared')
       OR (p_action = 'resume' AND session_row.status <> 'paused')
       OR (p_action = 'stop' AND session_row.status = 'stopped') THEN
        RAISE EXCEPTION 'The requested session transition is not valid from its current state.'
            USING ERRCODE = '55000';
    END IF;

    UPDATE public.nj_brc_verification_sessions
    SET status = next_status, updated_by = actor.auth_user_id, updated_at = now()
    WHERE nj_brc_verification_sessions.id = p_session_id
    RETURNING nj_brc_verification_sessions.id, nj_brc_verification_sessions.status,
        nj_brc_verification_sessions.updated_at
    INTO id, status, updated_at;

    INSERT INTO public.nj_brc_verification_session_events(
        session_id, actor_id, action, from_status, to_status
    ) VALUES (p_session_id, actor.auth_user_id, p_action, session_row.status, next_status);

    INSERT INTO public.administration_audit_log(
        user_id, user_name, user_email, action, object_type, object_id, object_label, details
    ) VALUES (
        actor.auth_user_id, actor.name, actor.email, upper(p_action),
        'nj_brc_verification_sessions', p_session_id::TEXT, 'NJ BRC verification session',
        jsonb_build_object('from_status', session_row.status, 'to_status', next_status)
    );
    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_nj_brc_verification_session(INTEGER[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_nj_brc_verification_session_state(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_nj_brc_verification_queue(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_nj_brc_verification_session(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_nj_brc_verification_session(INTEGER[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_nj_brc_verification_session_state(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_nj_brc_verification_queue(TEXT, TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_nj_brc_verification_session(UUID) TO service_role;

COMMIT;
