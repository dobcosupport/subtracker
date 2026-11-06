import { requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { CommunicationInputError, communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { parseRequirementRule } from "@/lib/requirement-notifications";
import { insuranceRelatedItems } from "@/lib/followup-related-item";
import type { RequirementNotificationConfiguration } from "@/types/requirement-notifications";

async function allRows<T>(read: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const result = await read(offset, offset + 499);
    checkDatabaseError(result.error);
    if (!result.data) throw new Error("Requirement configuration could not be read.");
    rows.push(...result.data);
    if (result.data.length < 500) return rows;
  }
  throw new Error("Requirement configuration exceeds the supported display limit.");
}

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "view");
    const [types, rules, intervals, templates, approvals, contacts] = await Promise.all([
      allRows((a, b) => admin.from("compliance_types").select("id,compliance_name,requires_expiration,active").order("id").range(a, b)),
      allRows((a, b) => admin.from("requirement_notification_readiness").select("id,compliance_type_id,insurance_item_key,automatic_enabled,configuration_ready,schedule_type,sender_contact_id,internal_contact_id,revision").order("id").range(a, b)),
      allRows((a, b) => admin.from("requirement_notification_intervals").select("rule_id,days_before_expiration,enabled,template_id").order("rule_id").order("days_before_expiration").range(a, b)),
      allRows((a, b) => admin.from("communication_templates").select("id,name,channel,revision,is_active,subject,body").order("id").range(a, b)),
      allRows((a, b) => admin.from("communication_template_automation_approvals").select("template_id,template_revision,approved_by,approved_at").order("template_id").order("template_revision").range(a, b)),
      allRows((a, b) => admin.from("dobco_contacts").select("id,contact_name,is_active").order("id").range(a, b)),
    ]);
    const sources = [
      ...types.map(type => ({ compliance_type_id: type.id, insurance_item_key: null, name: type.compliance_name,
        retired: !type.active, expiration_allowed: type.requires_expiration, schedule_type: type.requires_expiration ? "expiration" as const : "non_expiring" as const })),
      ...insuranceRelatedItems.map(item => ({ compliance_type_id: null, insurance_item_key: item.key, name: item.label, retired: false, expiration_allowed: true, schedule_type: "expiration" as const })),
      { compliance_type_id: null, insurance_item_key: "certificate_of_insurance", name: "Certificate of Insurance (Retired / Historical)", retired: true, expiration_allowed: true, schedule_type: "expiration" as const },
    ];
    const result: RequirementNotificationConfiguration = {
      rules: sources.map(source => {
        const row = rules.find(rule => rule.compliance_type_id === source.compliance_type_id && rule.insurance_item_key === source.insurance_item_key);
        const schedule = row?.schedule_type === "non_expiring" ? "non_expiring" : "expiration";
        return { ...source, id: row?.id ?? null, automatic_enabled: row?.automatic_enabled ?? false, configuration_ready: row?.configuration_ready ?? false,
          schedule_type: row ? schedule : source.schedule_type, sender_contact_id: row?.sender_contact_id ?? null,
          internal_contact_id: row?.internal_contact_id ?? null, revision: row?.revision ?? 0,
          intervals: intervals.filter(interval => interval.rule_id === row?.id).map(({ days_before_expiration, enabled, template_id }) => ({ days_before_expiration, enabled, template_id })) };
      }),
      templates: templates.map(template => {
        const approval = approvals.find(row => row.template_id === template.id && row.template_revision === template.revision);
        return { ...template, approved_by: approval?.approved_by ?? null, approved_at: approval?.approved_at ?? null };
      }),
      contacts, execution_enabled: false,
    };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CommunicationInputError("Invalid rule request.");
    const { id, ...fields } = body as Record<string, unknown>;
    const ruleId = id == null ? null : communicationId(String(id));
    const input = parseRequirementRule(fields);
    const { data, error } = await admin.rpc("save_requirement_notification_rule", { p_actor: profile.auth_user_id, p_id: ruleId, p_input: input });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "REQUIREMENT_NOTIFICATION_RULE_UPDATED", "requirement_notification_rule", String(data), "Requirement notification rule", { changed_fields: Object.keys(input) });
    return Response.json({ id: data, execution_enabled: false });
  } catch (error) { return communicationError(error); }
}
