import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { requireCompose, templateColumns } from "@/lib/server-communication-compose";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { contractorFilter } from "@/lib/server-communication-history";
import { emailProviderPlan } from "@/lib/email-provider";
import { microsoftIdentityStatus } from "@/lib/server-email-provider";
import type { ChannelSettings } from "@/types/communications";

export async function GET(request: Request) {
  try {
    const { admin } = await requireCompose(request);
    const params = new URL(request.url).searchParams;
    const kind = params.get("kind") ?? "configuration";
    const offset = params.get("offset") ?? "0";
    if (!/^\d{1,7}$/.test(offset)) throw new AdminApiError("Invalid selection offset.", 400);
    const from = Number(offset), to = from + 49;
    const search = (params.get("search") ?? "").trim();
    if (search.length > 100 || /[%_\\]/.test(search)) throw new AdminApiError("Search must be at most 100 characters without wildcard characters.", 400);
    if (kind === "configuration") {
      const [channels, installation] = await Promise.all([
        admin.from("communication_channel_settings").select("channel,provider,enabled,automated_enabled,from_name,from_address,sending_phone_number,microsoft_tenant_id,microsoft_client_id,revision"),
        admin.from("user_invitation_email_settings").select("organization_name,application_name").single(),
      ]);
      checkDatabaseError(channels.error); checkDatabaseError(installation.error);
      const email = (channels.data ?? []).find((channel) => channel.channel === "email") as ChannelSettings | undefined;
      let authenticated = false;
      let deliveryTested = false;
      if (email?.provider === "microsoft_365") {
        const { data, error } = await admin.from("microsoft_email_connection_state")
          .select("settings_revision,authentication_status,delivery_status").eq("channel", "email").maybeSingle();
        if (error) throw new AdminApiError("Unable to verify Microsoft Email send readiness; apply the Step 6F migration.", 503);
        authenticated = data !== null && data.settings_revision === email.revision && data.authentication_status === "Verified";
        deliveryTested = data !== null && authenticated && data.delivery_status === "Accepted by Graph";
      }
      const manualSendReady = Boolean(email && email.provider === "microsoft_365" && emailProviderPlan(email, false).configuration_status === "Ready for Testing"
        && microsoftIdentityStatus(email) === "Ready" && authenticated && deliveryTested);
      return Response.json({
        channels: (channels.data ?? []).map(({ channel, provider, from_name, from_address, sending_phone_number }) => ({
          channel, provider, from_name, from_address, sending_phone_number,
          manual_send_ready: channel === "email" && manualSendReady,
        })),
        installation: installation.data,
      });
    }
    if (kind === "templates") {
      const { data, error } = await admin.from("communication_templates").select(templateColumns).eq("is_active", true).order("name").order("id").range(from, to);
      checkDatabaseError(error);
      return Response.json({ rows: data ?? [], next_offset: data?.length === 50 ? to + 1 : null });
    }
    if (kind === "contractors" || kind === "contacts") {
      await requireModulePermission(request, "contractors", "view");
      if (kind === "contractors") {
        const { data, error } = await admin.from("contractors").select("id,company_name").is("merged_into_contractor_id", null)
          .ilike("company_name", `%${search}%`).order("company_name").order("id").range(from, to);
        checkDatabaseError(error);
        return Response.json({ rows: data ?? [], next_offset: data?.length === 50 ? to + 1 : null });
      }
      const id = contractorFilter(params.get("contractor_id"));
      const { data, error } = await admin.from("contractor_contacts").select("id,contractor_id,contact_name,email,mobile_phone,is_active,receives_compliance_email,receives_compliance_sms,sms_consent_recorded")
        .eq("contractor_id", id).order("contact_name").order("id").range(from, to);
      checkDatabaseError(error);
      return Response.json({ rows: (data ?? []).map((row) => ({ id: row.id, contractor_id: row.contractor_id, type: "contractor_contact", contact_name: row.contact_name,
        email: row.email, mobile_phone: row.mobile_phone, is_active: row.is_active, receives_email: row.receives_compliance_email,
        receives_sms: row.receives_compliance_sms, sms_consent_recorded: row.sms_consent_recorded })), next_offset: data?.length === 50 ? to + 1 : null });
    }
    if (kind === "internal") {
      await requireModulePermission(request, "settings", "view");
      const { data, error } = await admin.from("dobco_contacts").select("id,contact_name,email,mobile_phone,is_active,receives_internal_email,receives_internal_sms,sms_consent_recorded")
        .order("contact_name").order("id").range(from, to);
      checkDatabaseError(error);
      return Response.json({ rows: (data ?? []).map((row) => ({ id: row.id, contractor_id: null, type: "dobco_contact", contact_name: row.contact_name,
        email: row.email, mobile_phone: row.mobile_phone, is_active: row.is_active, receives_email: row.receives_internal_email,
        receives_sms: row.receives_internal_sms, sms_consent_recorded: row.sms_consent_recorded })), next_offset: data?.length === 50 ? to + 1 : null });
    }
    if (kind === "projects") {
      await requireModulePermission(request, "projects", "view");
      const { data, error } = await admin.from("projects").select("id,project_number,project_name").ilike("project_name", `%${search}%`).order("project_number").order("id").range(from, to);
      checkDatabaseError(error);
      return Response.json({ rows: data ?? [], next_offset: data?.length === 50 ? to + 1 : null });
    }
    if (kind === "compliance") {
      await requireModulePermission(request, "contractors", "view");
      await requireModulePermission(request, "compliance", "view");
      const id = contractorFilter(params.get("contractor_id"));
      const { data, error } = await admin.from("contractor_compliance_status")
        .select("contractor_id,compliance_record_id,compliance_name,calculated_status,expiration_date,days_remaining")
        .eq("contractor_id", id).order("compliance_record_id").range(from, to);
      checkDatabaseError(error);
      return Response.json({ rows: data ?? [], next_offset: data?.length === 50 ? to + 1 : null });
    }
    throw new AdminApiError("Unknown selection source.", 400);
  } catch (error) { return communicationError(error); }
}
