import "server-only";
import { AdminApiError, type AdminContext } from "@/lib/server-admin";
import { checkDatabaseError } from "@/lib/server-communications";
import { MERGE_FIELDS, parseMessageTemplate, renderMessage, templateFollowupDefaults, unresolvedMergeMessage, type MergeValues } from "@/lib/communication-templates";
import { parseCommunicationFollowup, parseEmailImportance } from "@/lib/communications";
import type { CommunicationDraft, CommunicationFollowup, EmailImportance } from "@/types/communications";
import type { MessageTemplateInput } from "@/types/communication-compose";
import { renderEmailBody } from "@/lib/server-email-rich-text";

type Admin = AdminContext["admin"];
export interface TemplateRenderContext {
  values: MergeValues;
  template: MessageTemplateInput | null;
  followup: CommunicationFollowup;
  importance: EmailImportance;
}
export function readTemplateRenderContext(value: unknown): TemplateRenderContext {
  if (!value || typeof value !== "object" || !("values" in value) || !value.values || typeof value.values !== "object"
    || Array.isArray(value.values) || !("template" in value)) throw new AdminApiError("Template rendering context could not be verified.", 503);
  const values: MergeValues = {};
  for (const key of MERGE_FIELDS) {
    if (key in value.values) {
      const field = Reflect.get(value.values, key);
      if (field !== null && typeof field !== "string") throw new AdminApiError("Template merge value could not be verified.", 503);
      values[key] = field;
    }
  }
  let template: MessageTemplateInput | null = null;
  if (value.template !== null) {
    if (!value.template || typeof value.template !== "object") throw new AdminApiError("Template configuration could not be verified.", 503);
    const { name, category, channel, subject, body, is_active, purpose, followup_enabled, followup_status,
      followup_delay_days, followup_subject, followup_related_item, default_importance } = value.template as Record<string, unknown>;
    template = parseMessageTemplate({ name, category, channel, subject, body, is_active, purpose, followup_enabled,
      followup_status, followup_delay_days, followup_subject, followup_related_item,
      ...(default_importance === undefined ? {} : { default_importance }) }, false);
  }
  const followup = "followup" in value ? parseCommunicationFollowup(value.followup) : templateFollowupDefaults(template);
  return { values, template, followup, importance: parseEmailImportance("importance" in value ? value.importance : "normal") };
}
export async function resolveTemplateContext(context: Pick<AdminContext, "admin" | "profile">, draft: CommunicationDraft) {
  const { data, error } = await context.admin.rpc("communication_template_context", {
    p_actor: context.profile.auth_user_id, p_input: draft,
  });
  checkDatabaseError(error);
  if (!data || typeof data !== "object" || !("followup" in data)) {
    throw new AdminApiError("Message Follow-Up assessment is unavailable: the connected database requires the per-message Follow-Up migration. Nothing was sent or scheduled.", 503);
  }
  const resolved = readTemplateRenderContext(data);
  if (draft.importance !== undefined && (!("importance" in data) || resolved.importance !== draft.importance)) {
    throw new AdminApiError("Email Importance assessment requires the reviewed Email Importance database migration. Nothing was sent or scheduled.", 503);
  }
  const expected = draft.followup;
  if (expected && (Object.keys(expected) as (keyof CommunicationFollowup)[])
    .some(key => expected[key] !== resolved.followup[key])) {
    throw new AdminApiError("The database did not preserve the reviewed message Follow-Up configuration. Nothing was sent or scheduled.", 503);
  }
  if (resolved.followup.enabled && (draft.contractor_ids.length !== 1 || draft.compliance_record_ids.length > 1)) {
    throw new AdminApiError("Follow-Up requires one authoritative contractor and at most one exact compliance record. Project-only Follow-Ups are not supported by the existing model.", 400);
  }
  return resolved;
}
export function renderTemplateContent(subject: string, body: string, context: TemplateRenderContext) {
  const renderedSubject = renderMessage(subject, context.values), renderedBody = renderEmailBody(body, context.values);
  const followup = context.followup.enabled ? renderMessage(context.followup.subject, context.values) : null;
  const unresolved = [...new Set([...renderedSubject.unresolved, ...renderedBody.unresolved, ...(followup?.unresolved ?? [])])];
  if (unresolved.length) throw new AdminApiError(unresolvedMergeMessage(unresolved), 400);
  if (followup && (!followup.text.trim() || followup.text.length > 200)) throw new AdminApiError("Follow-Up Subject must resolve to 1–200 characters.", 400);
  return { subject: renderedSubject.text, body: renderedBody.html, followup_subject: followup?.text ?? null };
}
export async function validateSavedTemplateContent(admin: Admin, id: string, revision?: number) {
  const { data, error } = await admin.from("communication_messages").select("channel,status,revision,subject,body,context_snapshot").eq("id", id).single();
  checkDatabaseError(error);
  if (!data) throw new AdminApiError("Communication is unavailable.", 404);
  if (revision !== undefined && data.revision !== revision) throw new AdminApiError("Communication changed; reload before sending or scheduling.", 409);
  if (data.channel !== "email" || (revision !== undefined && data.status !== "Draft")) throw new AdminApiError("Email Draft not found or no longer available.", 400);
  const snapshot = data.context_snapshot?.template_render;
  const context = snapshot ? readTemplateRenderContext(snapshot) : readTemplateRenderContext({ values: {}, template: null });
  // Saved email content is final, not re-merged; only the snapshotted Follow-Up subject is rendered.
  const final = renderTemplateContent(data.subject ?? "", data.body, readTemplateRenderContext({ values: {}, template: null }));
  if (context.followup.enabled) renderTemplateContent("", "", context);
  return final;
}
