-- Canonicalize timestamp serialization only; does not execute the correction.
BEGIN;

ALTER FUNCTION public.mycoi_compliance3_ownership_proposal()
    SET TimeZone TO 'UTC';

COMMIT;
