BEGIN;

ALTER TABLE public.communication_channel_settings
    DROP CONSTRAINT communication_channel_settings_provider_check;
ALTER TABLE public.communication_channel_settings
    ADD CONSTRAINT communication_channel_settings_provider_check
    CHECK (provider IS NULL OR provider = 'azure_communication_services'
        OR (channel = 'sms' AND provider = 'twilio'));

COMMIT;
