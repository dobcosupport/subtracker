import type { CustomExportConfiguration, ExportFilters, ExportFormat, ExportScope, ExportSort } from "./custom-export";

export const TEMPLATE_CATEGORIES = [
  { id: "contractors", label: "Contractors" },
  { id: "compliance", label: "Compliance" },
  { id: "insurance", label: "Insurance" },
  { id: "projects", label: "Projects" },
  { id: "executive", label: "Executive" },
  { id: "personal", label: "Personal" },
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]["id"];

export interface ExportTemplate {
  id: string;
  name: string;
  description: string | null;
  category: TemplateCategory;
  field_ids: string[];
  default_format: ExportFormat;
  default_scope: ExportScope;
  sort_configuration: ExportSort | null;
  filter_configuration: ExportFilters | null;
  configuration_version: number;
  owner_user_id: string | null;
  created_by: string | null;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  revision: number;
  active: boolean;
  visibility: "private" | "shared";
  is_system: boolean;
  system_key: string | null;
}
export interface ExportTemplateDraft {
  name: string;
  description: string | null;
  category: TemplateCategory;
  configuration: CustomExportConfiguration;
  active: boolean;
  visibility: "private" | "shared";
}
export interface TemplatePreference {
  template_id: string;
  is_favorite: boolean;
  is_default: boolean;
}
