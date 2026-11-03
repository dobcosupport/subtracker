BEGIN;

GRANT EXECUTE ON FUNCTION public.contractor_import_name_key(TEXT) TO authenticated;

COMMIT;
