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
}

export type CustomExportRow = Record<string, string>;
