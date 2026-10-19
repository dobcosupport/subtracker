import type { ChannelSettingsInput, SmsVerificationStatus } from "@/types/communications";

export const smsVerificationLabels: Record<SmsVerificationStatus, string> = {
  not_recorded: "Not Recorded",
  not_submitted: "Not Submitted",
  under_review: "Submitted / Under Review",
  approved: "Approved",
  rejected: "Rejected",
};

export function smsProviderPlan(settings: ChannelSettingsInput, credentialConfigured: boolean): {
  configuration_status: "Incomplete" | "Credential Required" | "Verification Required" | "Verification Pending" | "Verification Rejected" | "Ready for Testing";
  test_enabled: false;
  send_enabled: false;
} {
  const complete = settings.provider === "azure_communication_services" && settings.enabled
    && Boolean(settings.sending_phone_number && /^\+[1-9]\d{6,14}$/.test(settings.sending_phone_number));
  const verification = settings.sms_verification_status ?? "not_recorded";
  return {
    configuration_status: !complete ? "Incomplete"
      : verification === "under_review" ? "Verification Pending"
        : verification === "rejected" ? "Verification Rejected"
          : verification !== "approved" ? "Verification Required"
            : !credentialConfigured ? "Credential Required" : "Ready for Testing",
    test_enabled: false,
    send_enabled: false,
  };
}
