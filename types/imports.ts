export type ImportSheetName =
  | "Projects"
  | "Contractors"
  | "Project Assignments"
  | "Compliance Records"
  | "Insurance"
  | "Tiered Subs"
  | "Follow-Ups";

export type ImportAction = "Create" | "Update" | "Skip" | "Error";

export interface ImportRowError {
  worksheet: ImportSheetName;
  rowNumber: number;
  identifier: string;
  field: string;
  message: string;
  originalValue?: string;
}

export interface ImportPreviewRow {
  worksheet: ImportSheetName;
  rowNumber: number;
  identifier: string;
  action: ImportAction;
  data: Record<string, unknown>;
  errors: ImportRowError[];
}

export interface WorksheetSummary {
  worksheet: ImportSheetName;
  totalRows: number;
  validRows: number;
  newRecords: number;
  updateRecords: number;
  skippedRows: number;
  errorRows: number;
}

export interface ImportPreviewResult {
  fileName: string;
  summaries: WorksheetSummary[];
  rowsBySheet: Record<ImportSheetName, ImportPreviewRow[]>;
}

export interface ImportRunResult {
  totalProcessed: number;
  successful: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: ImportRowError[];
}
