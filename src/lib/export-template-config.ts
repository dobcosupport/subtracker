import { EXPORT_FIELDS, selectedExportFields } from "./custom-export";
import { TEMPLATE_CATEGORIES, type ExportTemplate, type ExportTemplateDraft } from "../types/export-template";
import type { CustomExportConfiguration, ExportFilters, ExportSort } from "../types/custom-export";

export const EXPORT_SORT_FIELDS = ["contractor_name", "sage_erp_id", "city", "state", "zip_code"] as const;

export function validateExportOptions(sort: ExportSort | null | undefined, filters: ExportFilters | null | undefined): void {
  if (sort !== undefined && sort !== null && (typeof sort !== "object" || Array.isArray(sort) || !EXPORT_SORT_FIELDS.includes(sort.field) || !["asc", "desc"].includes(sort.direction) || Object.keys(sort).some((key) => !["field", "direction"].includes(key)))) {
    throw new Error("Unsupported export sort configuration.");
  }
  if (filters !== undefined && filters !== null) {
    if (typeof filters !== "object" || Array.isArray(filters)) throw new Error("Unsupported export filter configuration.");
    if (Object.keys(filters).some((key) => !["contractor_status", "material_vendor_only", "state", "city", "contractor_name"].includes(key))) throw new Error("Unsupported export filter.");
    if (filters.contractor_status !== undefined && !["Active", "Inactive"].includes(filters.contractor_status)) throw new Error("Invalid contractor status filter.");
    if (filters.material_vendor_only !== undefined && typeof filters.material_vendor_only !== "boolean") throw new Error("Invalid material vendor filter.");
    for (const key of ["state", "city", "contractor_name"] as const) {
      const value = filters[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 200)) throw new Error(`Invalid ${key} filter.`);
    }
  }
}

export function validateExportConfiguration(configuration: CustomExportConfiguration): void {
  selectedExportFields(configuration.fields);
  if (!["xlsx", "csv"].includes(configuration.format)) throw new Error("Unsupported export format.");
  if (!["filtered", "all"].includes(configuration.scope)) throw new Error("Unsupported export scope.");
  validateExportOptions(configuration.sort, configuration.filters);
}

export function templateConfiguration(template: ExportTemplate): CustomExportConfiguration {
  if (template.configuration_version !== 1) throw new Error("This template uses an unsupported configuration version. Update it before exporting.");
  if (!TEMPLATE_CATEGORIES.some((category) => category.id === template.category)) throw new Error("This template has an unsupported category.");
  const configuration = { fields: [...template.field_ids], format: template.default_format, scope: template.default_scope, sort: template.sort_configuration, filters: template.filter_configuration };
  validateExportConfiguration(configuration);
  return configuration;
}

export function validateTemplateDraft(draft: ExportTemplateDraft): void {
  if (!draft.name.trim() || draft.name.trim().length > 120) throw new Error("Template name must contain 1-120 characters.");
  if (draft.description !== null && draft.description.length > 2000) throw new Error("Description must be 2000 characters or fewer.");
  if (!TEMPLATE_CATEGORIES.some((category) => category.id === draft.category)) throw new Error("Select a supported category.");
  if (!["private", "shared"].includes(draft.visibility) || typeof draft.active !== "boolean") throw new Error("Invalid template visibility or active status.");
  validateExportConfiguration(draft.configuration);
}

export function newTemplateDraft(): ExportTemplateDraft {
  return {
    name: "", description: null, category: "contractors", active: true, visibility: "private",
    configuration: { fields: EXPORT_FIELDS.filter((field) => field.defaultSelected).map((field) => field.id), format: "xlsx", scope: "filtered", sort: null, filters: null },
  };
}
