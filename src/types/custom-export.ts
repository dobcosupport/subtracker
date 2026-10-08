export type ExportScope = "filtered" | "all";
export type ExportFormat = "xlsx" | "csv";
export type ExportGroup = "company" | "nj" | "ny" | "insurance" | "projects" | "followup" | "quality";

export interface ExportField {
  id: string;
  label: string;
  group: ExportGroup;
  defaultSelected?: boolean;
}

export interface CustomExportConfiguration {
  fields: string[];
  scope: ExportScope;
  format: ExportFormat;
  sort?: ExportSort | null;
  filters?: ExportFilters | null;
}

export type ExportSortField = "contractor_name" | "sage_erp_id" | "city" | "state" | "zip_code";
export interface ExportSort {
  field: ExportSortField;
  direction: "asc" | "desc";
}
export interface ExportFilters {
  contractor_status?: "Active" | "Inactive";
  material_vendor_only?: boolean;
  state?: string;
  city?: string;
  contractor_name?: string;
}

export type CustomExportRow = Record<string, string>;
