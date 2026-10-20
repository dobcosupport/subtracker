BEGIN;

CREATE TABLE IF NOT EXISTS public.contractor_contact_consolidation_runs (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    migration_name TEXT NOT NULL,
    create_count INTEGER NOT NULL,
    review_required_count INTEGER NOT NULL,
    source_record_count INTEGER NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contractor_contact_consolidation_lineage (
    contractor_id INTEGER PRIMARY KEY,
    source_contact_name TEXT,
    source_email TEXT,
    source_phone TEXT,
    classification TEXT NOT NULL
        CHECK (classification IN ('CREATE', 'REVIEW_REQUIRED')),
    review_reason TEXT,
    contractor_contact_id UUID UNIQUE,
    created_contact_snapshot JSONB,
    migration_status TEXT NOT NULL
        CHECK (migration_status IN (
            'PENDING', 'CREATED', 'REVIEW_REQUIRED', 'ROLLED_BACK',
            'ROLLBACK_ALREADY_ABSENT', 'ROLLBACK_SKIPPED_MODIFIED'
        )),
    migration_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CHECK (
        (migration_status IN (
            'CREATED', 'ROLLED_BACK', 'ROLLBACK_ALREADY_ABSENT',
            'ROLLBACK_SKIPPED_MODIFIED'
        ) AND contractor_contact_id IS NOT NULL
          AND created_contact_snapshot IS NOT NULL)
        OR migration_status NOT IN (
            'CREATED', 'ROLLED_BACK', 'ROLLBACK_ALREADY_ABSENT',
            'ROLLBACK_SKIPPED_MODIFIED'
        )
    )
);

ALTER TABLE public.contractor_contact_consolidation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_contact_consolidation_lineage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contractor_contact_consolidation_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.contractor_contact_consolidation_lineage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_contact_consolidation_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_contact_consolidation_lineage TO service_role;

COMMENT ON TABLE public.contractor_contact_consolidation_runs IS
    'Restricted execution marker for the atomic legacy Contractor Contact conversion.';
COMMENT ON TABLE public.contractor_contact_consolidation_lineage IS
    'Restricted migration lineage preserving exact source fields and IDs/snapshots of Contacts created by the conversion.';

CREATE OR REPLACE FUNCTION public.rollback_contractor_contact_consolidation()
RETURNS TABLE (deleted INTEGER, skipped_modified INTEGER, already_absent INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    lineage_row public.contractor_contact_consolidation_lineage%ROWTYPE;
    contact_row public.contractor_contacts%ROWTYPE;
    deleted_count INTEGER := 0;
    modified_count INTEGER := 0;
    absent_count INTEGER := 0;
BEGIN
    FOR lineage_row IN
        SELECT *
        FROM public.contractor_contact_consolidation_lineage
        WHERE migration_status = 'CREATED'
        ORDER BY contractor_id
        FOR UPDATE
    LOOP
        SELECT *
        INTO contact_row
        FROM public.contractor_contacts
        WHERE id = lineage_row.contractor_contact_id
          AND contractor_id = lineage_row.contractor_id
        FOR UPDATE;

        IF NOT FOUND THEN
            UPDATE public.contractor_contact_consolidation_lineage
            SET migration_status = 'ROLLBACK_ALREADY_ABSENT',
                completed_at = now()
            WHERE contractor_id = lineage_row.contractor_id;
            absent_count := absent_count + 1;
        ELSIF to_jsonb(contact_row) IS DISTINCT FROM lineage_row.created_contact_snapshot THEN
            UPDATE public.contractor_contact_consolidation_lineage
            SET migration_status = 'ROLLBACK_SKIPPED_MODIFIED',
                review_reason = concat_ws(
                    '; ',
                    NULLIF(review_reason, ''),
                    'Rollback skipped because the migration-created Contact changed after insertion.'
                ),
                completed_at = now()
            WHERE contractor_id = lineage_row.contractor_id;
            modified_count := modified_count + 1;
        ELSE
            DELETE FROM public.contractor_contacts
            WHERE id = lineage_row.contractor_contact_id
              AND contractor_id = lineage_row.contractor_id;
            UPDATE public.contractor_contact_consolidation_lineage
            SET migration_status = 'ROLLED_BACK',
                completed_at = now()
            WHERE contractor_id = lineage_row.contractor_id;
            deleted_count := deleted_count + 1;
        END IF;
    END LOOP;

    RETURN QUERY SELECT deleted_count, modified_count, absent_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rollback_contractor_contact_consolidation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_contractor_contact_consolidation() TO service_role;

DO $$
DECLARE
    create_count INTEGER;
    review_required_count INTEGER;
    source_record_count INTEGER;
    inserted_count INTEGER;
    lineage_create_count INTEGER;
    lineage_review_count INTEGER;
BEGIN
    LOCK TABLE public.contractors IN SHARE ROW EXCLUSIVE MODE;
    LOCK TABLE public.contractor_contacts IN SHARE ROW EXCLUSIVE MODE;

    IF EXISTS (SELECT 1 FROM public.contractor_contact_consolidation_runs WHERE singleton) THEN
        IF NOT EXISTS (
            SELECT 1
            FROM public.contractor_contact_consolidation_runs AS run
            WHERE run.singleton
              AND run.migration_name = '20261103_contractor_contact_consolidation'
              AND run.create_count = 163
              AND run.review_required_count = 155
              AND run.source_record_count = 318
        ) THEN
            RAISE EXCEPTION 'Existing Contractor Contact consolidation marker is inconsistent.';
        END IF;
        SELECT
            count(*) FILTER (WHERE classification = 'CREATE')::INTEGER,
            count(*) FILTER (WHERE classification = 'REVIEW_REQUIRED')::INTEGER
        INTO lineage_create_count, lineage_review_count
        FROM public.contractor_contact_consolidation_lineage;
        IF lineage_create_count IS DISTINCT FROM 163
           OR lineage_review_count IS DISTINCT FROM 155
           OR EXISTS (
               SELECT 1
               FROM public.contractor_contact_consolidation_lineage
               WHERE classification = 'CREATE'
                 AND contractor_contact_id IS NULL
           )
           OR EXISTS (
               SELECT 1
               FROM public.contractor_contact_consolidation_lineage
               WHERE classification = 'REVIEW_REQUIRED'
                 AND contractor_contact_id IS NOT NULL
           ) THEN
            RAISE EXCEPTION 'Existing Contractor Contact lineage is incomplete or inconsistent.';
        END IF;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM public.contractor_contact_consolidation_lineage) THEN
        RAISE EXCEPTION 'Unexpected pre-existing Contractor Contact lineage without a completed run.';
    END IF;

    CREATE TEMPORARY TABLE contractor_contact_consolidation_snapshot
    ON COMMIT DROP
    AS
    SELECT
        contractor.id AS contractor_id,
        contractor.contact_name AS source_contact_name,
        contractor.email AS source_email,
        contractor.phone AS source_phone,
        CASE
            WHEN NULLIF(btrim(COALESCE(contractor.contact_name, '')), '') IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM public.contractor_contacts AS existing
                  WHERE existing.contractor_id = contractor.id
                    AND (
                        (
                            NULLIF(btrim(COALESCE(contractor.email, '')), '') IS NOT NULL
                            AND lower(btrim(existing.email)) = lower(btrim(contractor.email))
                        )
                        OR lower(regexp_replace(btrim(existing.contact_name), '[[:space:]]+', ' ', 'g'))
                           = lower(regexp_replace(btrim(contractor.contact_name), '[[:space:]]+', ' ', 'g'))
                    )
              )
                THEN 'REVIEW_REQUIRED'
            ELSE 'CREATE'
        END AS classification,
        concat_ws(
            '; ',
            CASE
                WHEN NULLIF(btrim(COALESCE(contractor.contact_name, '')), '') IS NULL
                    THEN 'Missing Contact Name; no Contact created.'
                WHEN EXISTS (
                    SELECT 1
                    FROM public.contractor_contacts AS existing
                    WHERE existing.contractor_id = contractor.id
                      AND (
                          (
                              NULLIF(btrim(COALESCE(contractor.email, '')), '') IS NOT NULL
                              AND lower(btrim(existing.email)) = lower(btrim(contractor.email))
                          )
                          OR lower(regexp_replace(btrim(existing.contact_name), '[[:space:]]+', ' ', 'g'))
                             = lower(regexp_replace(btrim(contractor.contact_name), '[[:space:]]+', ' ', 'g'))
                      )
                )
                    THEN 'Possible same-Contractor Contact match; review instead of guessing.'
            END,
            CASE
                WHEN NULLIF(btrim(COALESCE(contractor.phone, '')), '') IS NOT NULL
                    THEN 'Legacy contractors.phone retained unchanged and not migrated.'
            END
        ) AS review_reason
    FROM public.contractors AS contractor
    WHERE NULLIF(btrim(COALESCE(contractor.contact_name, '')), '') IS NOT NULL
       OR NULLIF(btrim(COALESCE(contractor.email, '')), '') IS NOT NULL
       OR NULLIF(btrim(COALESCE(contractor.phone, '')), '') IS NOT NULL;

    SELECT
        count(*) FILTER (WHERE classification = 'CREATE')::INTEGER,
        count(*) FILTER (WHERE classification = 'REVIEW_REQUIRED')::INTEGER,
        count(*)::INTEGER
    INTO create_count, review_required_count, source_record_count
    FROM contractor_contact_consolidation_snapshot;

    IF create_count IS DISTINCT FROM 163
       OR review_required_count IS DISTINCT FROM 155
       OR source_record_count IS DISTINCT FROM 318 THEN
        RAISE EXCEPTION
            'Contractor Contact inventory changed: expected 163 CREATE, 155 REVIEW_REQUIRED, 318 source records; found %, %, %. No data was converted.',
            create_count, review_required_count, source_record_count
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.contractor_contact_consolidation_lineage (
        contractor_id,
        source_contact_name,
        source_email,
        source_phone,
        classification,
        review_reason,
        migration_status
    )
    SELECT
        contractor_id,
        source_contact_name,
        source_email,
        source_phone,
        classification,
        review_reason,
        CASE WHEN classification = 'CREATE' THEN 'PENDING' ELSE 'REVIEW_REQUIRED' END
    FROM contractor_contact_consolidation_snapshot;

    CREATE TEMPORARY TABLE contractor_contact_consolidation_existing_contacts
    ON COMMIT DROP
    AS
    SELECT contact.id, to_jsonb(contact) AS row_snapshot
    FROM public.contractor_contacts AS contact;

    IF (SELECT count(*) FROM contractor_contact_consolidation_existing_contacts) IS DISTINCT FROM 2::BIGINT THEN
        RAISE EXCEPTION 'Expected exactly 2 pre-existing Contractor Contacts; transaction aborted.';
    END IF;

    WITH inserted_contacts AS (
        INSERT INTO public.contractor_contacts (contractor_id, contact_name, email)
        SELECT
            snapshot.contractor_id,
            btrim(snapshot.source_contact_name),
            NULLIF(btrim(COALESCE(snapshot.source_email, '')), '')
        FROM contractor_contact_consolidation_snapshot AS snapshot
        WHERE snapshot.classification = 'CREATE'
          AND NOT EXISTS (
              SELECT 1
              FROM public.contractor_contacts AS existing
              WHERE existing.contractor_id = snapshot.contractor_id
                AND (
                    (
                        NULLIF(btrim(COALESCE(snapshot.source_email, '')), '') IS NOT NULL
                        AND lower(btrim(existing.email)) = lower(btrim(snapshot.source_email))
                    )
                    OR lower(regexp_replace(btrim(existing.contact_name), '[[:space:]]+', ' ', 'g'))
                       = lower(regexp_replace(btrim(snapshot.source_contact_name), '[[:space:]]+', ' ', 'g'))
                )
          )
        RETURNING *
    )
    UPDATE public.contractor_contact_consolidation_lineage AS lineage
    SET contractor_contact_id = inserted.id,
        created_contact_snapshot = to_jsonb(inserted),
        migration_status = 'CREATED',
        migration_at = now(),
        completed_at = now()
    FROM inserted_contacts AS inserted
    WHERE lineage.contractor_id = inserted.contractor_id
      AND lineage.classification = 'CREATE';

    SELECT count(*)::INTEGER
    INTO inserted_count
    FROM public.contractor_contact_consolidation_lineage
    WHERE classification = 'CREATE'
      AND contractor_contact_id IS NOT NULL;

    IF inserted_count IS DISTINCT FROM create_count THEN
        RAISE EXCEPTION
            'Expected to create % Contractor Contacts but lineage records %; transaction aborted.',
            create_count, inserted_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.contractor_contact_consolidation_lineage AS lineage
        LEFT JOIN public.contractors AS source
            ON source.id = lineage.contractor_id
        WHERE source.id IS NULL
           OR source.contact_name IS DISTINCT FROM lineage.source_contact_name
           OR source.email IS DISTINCT FROM lineage.source_email
           OR source.phone IS DISTINCT FROM lineage.source_phone
    ) THEN
        RAISE EXCEPTION 'Legacy Contractor values changed during conversion; transaction aborted.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.contractor_contact_consolidation_lineage AS lineage
        JOIN public.contractor_contacts AS contact
            ON contact.id = lineage.contractor_contact_id
        WHERE lineage.classification = 'CREATE'
          AND (
              contact.contractor_id IS DISTINCT FROM lineage.contractor_id
              OR contact.contact_name IS DISTINCT FROM btrim(lineage.source_contact_name)
              OR contact.email IS DISTINCT FROM NULLIF(btrim(COALESCE(lineage.source_email, '')), '')
              OR contact.mobile_phone IS NOT NULL
              OR contact.title_or_role IS NOT NULL
              OR contact.is_primary_contact
              OR contact.is_compliance_contact
              OR contact.receives_compliance_email
              OR contact.receives_compliance_sms
              OR contact.sms_consent_recorded
              OR contact.sms_consent_date IS NOT NULL
              OR contact.sms_consent_source_or_note IS NOT NULL
          )
    ) THEN
        RAISE EXCEPTION 'Created Contractor Contact values failed preservation checks; transaction aborted.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.contractor_contact_consolidation_lineage AS lineage
        WHERE lineage.classification = 'REVIEW_REQUIRED'
          AND lineage.contractor_contact_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'A review-required Contractor was converted; transaction aborted.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM contractor_contact_consolidation_existing_contacts AS before
        LEFT JOIN public.contractor_contacts AS after ON after.id = before.id
        WHERE after.id IS NULL
           OR to_jsonb(after) IS DISTINCT FROM before.row_snapshot
    ) OR (
        SELECT count(*) FROM public.contractor_contacts
    ) <> (
        SELECT count(*) FROM contractor_contact_consolidation_existing_contacts
    ) + inserted_count THEN
        RAISE EXCEPTION 'Pre-existing Contractor Contacts changed during conversion; transaction aborted.';
    END IF;

    INSERT INTO public.contractor_contact_consolidation_runs (
        singleton,
        migration_name,
        create_count,
        review_required_count,
        source_record_count
    ) VALUES (
        TRUE,
        '20261103_contractor_contact_consolidation',
        create_count,
        review_required_count,
        source_record_count
    );
END;
$$;

COMMIT;
