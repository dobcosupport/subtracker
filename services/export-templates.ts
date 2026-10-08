import { supabase } from "@/lib/supabase";
import { validateTemplateDraft } from "@/lib/export-template-config";
import type { ExportTemplate, ExportTemplateDraft, TemplatePreference } from "@/types/export-template";

const COLUMNS = "id,name,description,category,field_ids,default_format,default_scope,sort_configuration,filter_configuration,configuration_version,owner_user_id,created_by,created_by_name,created_at,updated_at,revision,active,visibility,is_system,system_key";

async function readAll<T>(query: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, signal: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await query(start, start + 499);
    signal.throwIfAborted();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Template query returned no data.");
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

export async function fetchExportTemplates(signal: AbortSignal): Promise<{ templates: ExportTemplate[]; preferences: TemplatePreference[] }> {
  try {
    const [templates, preferences] = await Promise.all([
      readAll<ExportTemplate>((start, end) => supabase.from("export_templates").select(COLUMNS).order("name").order("id").range(start, end).abortSignal(signal), signal),
      readAll<TemplatePreference>((start, end) => supabase.from("export_template_user_preferences").select("template_id,is_favorite,is_default").order("template_id").range(start, end).abortSignal(signal), signal),
    ]);
    return { templates, preferences };
  } catch (reason) {
    signal.throwIfAborted();
    throw new Error(`Unable to load saved templates: ${reason instanceof Error ? reason.message : "Unexpected retrieval failure"}. Ensure the Saved Export Templates migration is installed.`);
  }
}

export async function saveExportTemplate(draft: ExportTemplateDraft, existing?: ExportTemplate): Promise<ExportTemplate> {
  validateTemplateDraft(draft);
  const payload = {
    name: draft.name.trim(), description: draft.description?.trim() || null, category: draft.category,
    field_ids: draft.configuration.fields, default_format: draft.configuration.format, default_scope: draft.configuration.scope,
    sort_configuration: draft.configuration.sort ?? null, filter_configuration: draft.configuration.filters ?? null,
    configuration_version: 1, visibility: draft.visibility, active: draft.active,
  };
  const query = existing
    ? supabase.from("export_templates").update(payload).eq("id", existing.id).eq("revision", existing.revision)
    : supabase.from("export_templates").insert(payload);
  const { data, error } = await query.select(COLUMNS).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The template changed or is no longer editable. Refresh the template list before saving.");
  return data;
}

export async function deleteExportTemplate(template: ExportTemplate): Promise<void> {
  const { data, error } = await supabase.from("export_templates").delete().eq("id", template.id).eq("revision", template.revision).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("The template changed or is no longer deletable. Refresh before deleting.");
}

export async function setTemplatePreference(templateId: string, favorite: boolean, isDefault: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_export_template_preference", { p_template_id: templateId, p_favorite: favorite, p_default: isDefault });
  if (error) throw new Error(error.message);
}
