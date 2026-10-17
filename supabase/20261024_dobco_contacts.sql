BEGIN;

CREATE TABLE public.dobco_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_name TEXT NOT NULL CHECK (contact_name ~ '[^[:space:]]'),
    email TEXT,
    mobile_phone TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    receives_internal_email BOOLEAN NOT NULL DEFAULT FALSE,
    receives_internal_sms BOOLEAN NOT NULL DEFAULT FALSE,
    sms_consent_recorded BOOLEAN NOT NULL DEFAULT FALSE,
    sms_consent_date DATE,
    sms_consent_source_or_note TEXT,
    user_profile_id UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dobco_contacts_name
    ON public.dobco_contacts(contact_name, id);
CREATE INDEX idx_dobco_contacts_user_profile
    ON public.dobco_contacts(user_profile_id) WHERE user_profile_id IS NOT NULL;
CREATE INDEX idx_dobco_contacts_email_recipients
    ON public.dobco_contacts(id)
    WHERE is_active AND receives_internal_email AND email IS NOT NULL;
CREATE INDEX idx_dobco_contacts_sms_recipients
    ON public.dobco_contacts(id)
    WHERE is_active AND receives_internal_sms
      AND mobile_phone IS NOT NULL AND sms_consent_recorded;

CREATE FUNCTION public.touch_dobco_contact_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_dobco_contact_updated_at() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER dobco_contacts_updated_at
    BEFORE UPDATE ON public.dobco_contacts
    FOR EACH ROW EXECUTE FUNCTION public.touch_dobco_contact_updated_at();

ALTER TABLE public.dobco_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dobco_contacts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.dobco_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.dobco_contacts TO service_role;

CREATE POLICY dobco_contacts_select
    ON public.dobco_contacts FOR SELECT TO authenticated
    USING (public.user_has_module_permission('settings', 'view'));

-- No authenticated write policy: only the permission-checked server API writes.
-- No generic database audit trigger is required; the API uses the existing
-- administration audit helper. No users are copied, created, or updated here.
COMMENT ON TABLE public.dobco_contacts IS
    'Independent Dobco address book. Optional user profile relationship only; no automatic identity/status synchronization or communication delivery.';
COMMENT ON COLUMN public.dobco_contacts.sms_consent_recorded IS
    'Explicit SMS consent. A mobile phone number does not imply consent or enable SMS alerts.';

COMMIT;
