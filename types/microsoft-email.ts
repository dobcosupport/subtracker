export interface MicrosoftEmailConnection {
  identity_status: "Ready" | "Unavailable" | "Identity Mismatch";
  authentication_status: "Not Tested" | "Verified" | "Test Failed";
  diagnostic_category: string | null;
  delivery_status: "Not Tested" | "In Progress" | "Accepted by Graph" | "Test Failed" | "Outcome Unknown";
  overall_status: "Not Verified" | "Ready for Test Email" | "Verified";
  can_test: boolean;
  can_send_test: boolean;
}
