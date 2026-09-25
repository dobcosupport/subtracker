import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import type {
  ImportAction,
  ImportPreviewResult,
  ImportPreviewRow,
  ImportRowError,
  ImportRunResult,
  ImportSheetName,
  WorksheetSummary,
} from "@/types/imports";

export const SUPPORTED_SHEETS: ImportSheetName[] = [
  "Projects",
  "Contractors",
  "Project Assignments",
  "Compliance Records",
  "Insurance",
  "Tiered Subs",
  "Follow-Ups",
];

const IGNORED_SHEETS = new Set(["Instructions", "_Lists"]);

export const PROJECT_STATUSES = ["Active", "Pending", "Completed", "On Hold", "Cancelled"] as const;
export const COMPLIANCE_TYPE_NAMES = ["NJ PWC", "NJ BRC", "NY PWC", "NY BRC", "W9", "Safety Certification"] as const;
export const FOLLOWUP_METHOD_VALUES = ["Phone", "Email", "Meeting", "Text", "Other"] as const;
export const FOLLOWUP_STATUS_VALUES = ["Open", "Waiting Response", "Resolved", "Closed"] as const;

type RawRow = Record<string, unknown>;

// ---------- helpers ----------

export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/** Converts Yes/No cell values to booleans. Returns undefined when the value cannot be parsed. */
function toYesNoBoolean(value: unknown): boolean | null | undefined {
  const text = cellToString(value).toLowerCase();
  if (text === "") return null;
  if (text === "yes" || text === "true" || text === "1") return true;
  if (text === "no" || text === "false" || text === "0") return false;
  return undefined;
}

/** Converts a cell value to an ISO date string (YYYY-MM-DD). Returns undefined when invalid, null when empty. */
function toDateString(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

function excelRowNumber(index: number): number {
  return index + 2;
}

// ---------- workbook parsing ----------

export async function parseWorkbookFile(file: File): Promise<Partial<Record<ImportSheetName, RawRow[]>>> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const result: Partial<Record<ImportSheetName, RawRow[]>> = {};

  for (const sheetName of workbook.SheetNames) {
    if (IGNORED_SHEETS.has(sheetName)) continue;
    if (!SUPPORTED_SHEETS.includes(sheetName as ImportSheetName)) continue;
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: "" });
    result[sheetName as ImportSheetName] = rows;
  }

  return result;
}

// ---------- reference data ----------

export interface ReferenceContractor {
  id: number;
  company_name: string;
  external_id: string | null;
}

export interface ReferenceProject {
  id: number;
  project_number: string;
}

export interface ReferenceComplianceRecord {
  contractor_id: number;
  compliance_type_id: number;
  registration_number: string | null;
  expiration_date: string | null;
}

export interface ReferenceData {
  contractorsByExternalId: Map<string, ReferenceContractor>;
  contractorsByName: Map<string, ReferenceContractor>;
  projectsByNumber: Map<string, ReferenceProject>;
  complianceTypesByName: Map<string, { id: number; requires_expiration: boolean }>;
  complianceRecordKeys: Set<string>;
  activeAssignmentKeys: Set<string>;
  inactiveAssignmentKeys: Map<string, number>;
  contractorsWithInsurance: Set<number>;
  activeTieredSubKeys: Set<string>;
  inactiveTieredSubKeys: Map<string, number>;
}

function complianceKey(contractorId: number, complianceTypeId: number, registrationNumber: string | null, expirationDate: string | null): string {
  return `${contractorId}|${complianceTypeId}|${(registrationNumber ?? "").toLowerCase()}|${expirationDate ?? ""}`;
}

function assignmentKey(contractorId: number, projectId: number): string {
  return `${contractorId}|${projectId}`;
}

function tieredSubKey(contractorId: number, tieredSubContractorId: number): string {
  return `${contractorId}|${tieredSubContractorId}`;
}

export async function fetchReferenceData(): Promise<ReferenceData> {
  const [
    { data: contractors },
    { data: projects },
    { data: complianceTypes },
    { data: complianceRecords },
    { data: assignments },
    { data: insuranceRows },
    { data: tieredSubs },
  ] = await Promise.all([
    supabase.from("contractors").select("id, company_name, external_id"),
    supabase.from("projects").select("id, project_number"),
    supabase.from("compliance_types").select("id, compliance_name, requires_expiration"),
    supabase.from("compliance_records").select("contractor_id, compliance_type_id, registration_number, expiration_date"),
    supabase.from("contractor_projects").select("contractor_id, project_id, active, id"),
    supabase.from("contractor_insurance").select("contractor_id"),
    supabase.from("contractor_tiered_subs").select("contractor_id, tiered_sub_contractor_id, active, id"),
  ]);

  const contractorsByExternalId = new Map<string, ReferenceContractor>();
  const contractorsByName = new Map<string, ReferenceContractor>();
  for (const contractor of (contractors ?? []) as ReferenceContractor[]) {
    contractorsByName.set(normalizeCompanyName(contractor.company_name), contractor);
    if (contractor.external_id) {
      contractorsByExternalId.set(contractor.external_id.trim().toLowerCase(), contractor);
    }
  }

  const projectsByNumber = new Map<string, ReferenceProject>();
  for (const project of (projects ?? []) as ReferenceProject[]) {
    projectsByNumber.set(project.project_number.trim().toLowerCase(), project);
  }

  const complianceTypesByName = new Map<string, { id: number; requires_expiration: boolean }>();
  for (const type of (complianceTypes ?? []) as { id: number; compliance_name: string; requires_expiration: boolean }[]) {
    complianceTypesByName.set(type.compliance_name, { id: type.id, requires_expiration: type.requires_expiration });
  }

  const complianceRecordKeys = new Set<string>();
  for (const record of (complianceRecords ?? []) as ReferenceComplianceRecord[]) {
    complianceRecordKeys.add(complianceKey(record.contractor_id, record.compliance_type_id, record.registration_number, record.expiration_date));
  }

  const activeAssignmentKeys = new Set<string>();
  const inactiveAssignmentKeys = new Map<string, number>();
  for (const assignment of (assignments ?? []) as { contractor_id: number; project_id: number; active: boolean; id: number }[]) {
    const key = assignmentKey(assignment.contractor_id, assignment.project_id);
    if (assignment.active) activeAssignmentKeys.add(key);
    else inactiveAssignmentKeys.set(key, assignment.id);
  }

  const contractorsWithInsurance = new Set<number>();
  for (const row of (insuranceRows ?? []) as { contractor_id: number }[]) {
    contractorsWithInsurance.add(row.contractor_id);
  }

  const activeTieredSubKeys = new Set<string>();
  const inactiveTieredSubKeys = new Map<string, number>();
  for (const sub of (tieredSubs ?? []) as { contractor_id: number; tiered_sub_contractor_id: number; active: boolean; id: number }[]) {
    const key = tieredSubKey(sub.contractor_id, sub.tiered_sub_contractor_id);
    if (sub.active) activeTieredSubKeys.add(key);
    else inactiveTieredSubKeys.set(key, sub.id);
  }

  return {
    contractorsByExternalId,
    contractorsByName,
    projectsByNumber,
    complianceTypesByName,
    complianceRecordKeys,
    activeAssignmentKeys,
    inactiveAssignmentKeys,
    contractorsWithInsurance,
    activeTieredSubKeys,
    inactiveTieredSubKeys,
  };
}

// ---------- preview builders ----------

function makeRow(worksheet: ImportSheetName, rowNumber: number, identifier: string, data: Record<string, unknown>): { row: ImportPreviewRow; addError: (field: string, message: string, originalValue?: string) => void } {
  const errors: ImportRowError[] = [];
  const row: ImportPreviewRow = { worksheet, rowNumber, identifier, action: "Create", data, errors };
  return {
    row,
    addError: (field, message, originalValue) => {
      errors.push({ worksheet, rowNumber, identifier, field, message, originalValue });
    },
  };
}

function finalizeRow(row: ImportPreviewRow, plannedAction: ImportAction): ImportPreviewRow {
  row.action = row.errors.length > 0 ? "Error" : plannedAction;
  return row;
}

function buildProjectsPreview(rows: RawRow[], reference: ReferenceData): ImportPreviewRow[] {
  const seenInFile = new Map<string, ReferenceProject>();
  return rows.map((raw, index) => {
    const rowNumber = excelRowNumber(index);
    const projectNumber = cellToString(raw["Project Number"]);
    const identifier = projectNumber || `Row ${rowNumber}`;
    const { row, addError } = makeRow("Projects", rowNumber, identifier, {});

    const projectName = cellToString(raw["Project Name"]);
    const status = cellToString(raw["Status"]) || "Active";

    if (!projectNumber) addError("Project Number", "Project Number is required.");
    if (!projectName) addError("Project Name", "Project Name is required.");
    if (!PROJECT_STATUSES.includes(status as (typeof PROJECT_STATUSES)[number])) {
      addError("Status", `Status must be one of: ${PROJECT_STATUSES.join(", ")}.`, status);
    }

    row.data = { project_number: projectNumber, project_name: projectName, status };

    const key = projectNumber.trim().toLowerCase();
    const existing = reference.projectsByNumber.get(key) ?? seenInFile.get(key);
    const plannedAction: ImportAction = existing ? "Update" : "Create";
    if (!existing && projectNumber) seenInFile.set(key, { id: -1, project_number: projectNumber });

    return finalizeRow(row, plannedAction);
  });
}

function buildContractorsPreview(rows: RawRow[], reference: ReferenceData): ImportPreviewRow[] {
  const seenExternalIds = new Map<string, boolean>();
  const seenNames = new Map<string, boolean>();
  return rows.map((raw, index) => {
    const rowNumber = excelRowNumber(index);
    const companyName = cellToString(raw["Company Name"]);
    const identifier = companyName || `Row ${rowNumber}`;
    const { row, addError } = makeRow("Contractors", rowNumber, identifier, {});

    const externalId = cellToString(raw["External ID"]) || null;
    const active = toYesNoBoolean(raw["Active"]);

    if (!companyName) addError("Company Name", "Company Name is required.");
    if (active === undefined) addError("Active", "Active must be Yes or No.", cellToString(raw["Active"]));

    row.data = {
      company_name: companyName,
      trade: cellToString(raw["Trade"]) || null,
      contact_name: cellToString(raw["Contact Name"]) || null,
      email: cellToString(raw["Email"]) || null,
      phone: cellToString(raw["Phone"]) || null,
      notes: cellToString(raw["Notes"]) || null,
      external_id: externalId,
      legacy_id: cellToString(raw["Legacy ID"]) || null,
      active: active ?? true,
    };

    const normalizedName = normalizeCompanyName(companyName);
    const matchByExternalId = externalId ? reference.contractorsByExternalId.get(externalId.trim().toLowerCase()) : undefined;
    const matchByName = reference.contractorsByName.get(normalizedName);
    const existing = matchByExternalId ?? matchByName;
    const alreadyInFile = (externalId ? seenExternalIds.get(externalId.trim().toLowerCase()) : undefined) ?? seenNames.get(normalizedName);

    if (companyName && externalId) seenExternalIds.set(externalId.trim().toLowerCase(), true);
    if (companyName) seenNames.set(normalizedName, true);

    const plannedAction: ImportAction = existing || alreadyInFile ? "Update" : "Create";
    return finalizeRow(row, plannedAction);
  });
}

function buildProjectAssignmentsPreview(
  rows: RawRow[],
  reference: ReferenceData,
  contractorsCreatedInFile: Set<string>,
  projectsCreatedInFile: Set<string>
): ImportPreviewRow[] {
  const seenActiveKeys = new Set<string>();
  return rows.map((raw, index) => {
    const rowNumber = excelRowNumber(index);
    const companyName = cellToString(raw["Company Name"]);
    const projectNumber = cellToString(raw["Project Number"]);
    const identifier = companyName || `Row ${rowNumber}`;
    const { row, addError } = makeRow("Project Assignments", rowNumber, identifier, {});

    const assignedDate = toDateString(raw["Assigned Date"]);
    const active = toYesNoBoolean(raw["Active"]) ?? true;

    if (!companyName) addError("Company Name", "Company Name is required.");
    if (!projectNumber) addError("Project Number", "Project Number is required.");
    if (assignedDate === undefined) addError("Assigned Date", "Assigned Date is not a valid date.", cellToString(raw["Assigned Date"]));

    const normalizedName = normalizeCompanyName(companyName);
    const contractorExists = reference.contractorsByName.has(normalizedName) || contractorsCreatedInFile.has(normalizedName);
    const projectKey = projectNumber.trim().toLowerCase();
    const projectExists = reference.projectsByNumber.has(projectKey) || projectsCreatedInFile.has(projectKey);

    if (companyName && !contractorExists) addError("Company Name", "No matching contractor found.", companyName);
    if (projectNumber && !projectExists) addError("Project Number", "No matching project found.", projectNumber);

    row.data = { company_name: companyName, project_number: projectNumber, assigned_date: assignedDate || null, active };

    let plannedAction: ImportAction = "Create";
    if (contractorExists && projectExists) {
      const existingContractor = reference.contractorsByName.get(normalizedName);
      const existingProject = reference.projectsByNumber.get(projectKey);
      if (existingContractor && existingProject) {
        const key = assignmentKey(existingContractor.id, existingProject.id);
        if (active && (reference.activeAssignmentKeys.has(key) || seenActiveKeys.has(key))) {
          plannedAction = "Skip";
          if (row.errors.length === 0) addError("Active", "An active assignment already exists for this contractor and project.");
        } else if (!active) {
          plannedAction = reference.inactiveAssignmentKeys.has(key) || reference.activeAssignmentKeys.has(key) ? "Update" : "Create";
        } else {
          plannedAction = reference.inactiveAssignmentKeys.has(key) ? "Update" : "Create";
        }
        if (active) seenActiveKeys.add(key);
      }
    }

    return finalizeRow(row, plannedAction);
  });
}

function buildComplianceRecordsPreview(rows: RawRow[], reference: ReferenceData, contractorsCreatedInFile: Set<string>): ImportPreviewRow[] {
  return rows.map((raw, index) => {
    const rowNumber = excelRowNumber(index);
    const companyName = cellToString(raw["Company Name"]);
    const complianceTypeName = cellToString(raw["Compliance Type"]);
    const identifier = companyName || `Row ${rowNumber}`;
    const { row, addError } = makeRow("Compliance Records", rowNumber, identifier, {});

    const registrationNumber = cellToString(raw["Registration Number"]) || null;
    const effectiveDate = toDateString(raw["Effective Date"]);
    const expirationDate = toDateString(raw["Expiration Date"]);
    const verifiedDate = toDateString(raw["Verified Date"]);
    const active = toYesNoBoolean(raw["Active"]) ?? true;
    const isCurrent = toYesNoBoolean(raw["Current"]) ?? true;

    if (!companyName) addError("Company Name", "Company Name is required.");
    if (!complianceTypeName) addError("Compliance Type", "Compliance Type is required.");
    else if (!COMPLIANCE_TYPE_NAMES.includes(complianceTypeName as (typeof COMPLIANCE_TYPE_NAMES)[number])) {
      addError("Compliance Type", `Compliance Type must be one of: ${COMPLIANCE_TYPE_NAMES.join(", ")}.`, complianceTypeName);
    }
    if (effectiveDate === undefined) addError("Effective Date", "Effective Date is not a valid date.", cellToString(raw["Effective Date"]));
    if (expirationDate === undefined) addError("Expiration Date", "Expiration Date is not a valid date.", cellToString(raw["Expiration Date"]));
    if (verifiedDate === undefined) addError("Verified Date", "Verified Date is not a valid date.", cellToString(raw["Verified Date"]));

    const normalizedName = normalizeCompanyName(companyName);
    const contractorExists = reference.contractorsByName.has(normalizedName) || contractorsCreatedInFile.has(normalizedName);
    if (companyName && !contractorExists) addError("Company Name", "No matching contractor found.", companyName);

    row.data = {
      company_name: companyName,
      compliance_type_name: complianceTypeName,
      registration_number: registrationNumber,
      effective_date: effectiveDate || null,
      expiration_date: expirationDate || null,
      verified_date: verifiedDate || null,
      verified_by: cellToString(raw["Verified By"]) || null,
      verification_source: cellToString(raw["Verification Source"]) || null,
      notes: cellToString(raw["Notes"]) || null,
      active,
      is_current: isCurrent,
    };

    let plannedAction: ImportAction = "Create";
    const existingContractor = reference.contractorsByName.get(normalizedName);
    const complianceType = reference.complianceTypesByName.get(complianceTypeName);
    if (existingContractor && complianceType) {
      const key = complianceKey(existingContractor.id, complianceType.id, registrationNumber, expirationDate || null);
      plannedAction = reference.complianceRecordKeys.has(key) ? "Update" : "Create";
    }

    return finalizeRow(row, plannedAction);
  });
}

function buildInsurancePreview(rows: RawRow[], reference: ReferenceData, contractorsCreatedInFile: Set<string>): ImportPreviewRow[] {
  return rows.map((raw, index) => {
    const rowNumber = excelRowNumber(index);
    const companyName = cellToString(raw["Company Name"]);
    const identifier = companyName || `Row ${rowNumber}`;
    const { row, addError } = makeRow("Insurance", rowNumber, identifier, {});

    const coiOnFile = toYesNoBoolean(raw["COI On File"]);
    const generalLiabilityOnFile = toYesNoBoolean(raw["General Liability On File"]);
    const workersCompOnFile = toYesNoBoolean(raw["Workers Comp On File"]);
    const generalLiabilityExpiration = toDateString(raw["General Liability Expiration Date"]);
    const workersCompExpiration = toDateString(raw["Workers Comp Expiration Date"]);

    if (!companyName) addError("Company Name", "Company Name is required.");
    if (coiOnFile === undefined) addError("COI On File", "COI On File must be Yes or No.", cellToString(raw["COI On File"]));
    if (generalLiabilityOnFile === undefined) addError("General Liability On File", "General Liability On File must be Yes or No.", cellToString(raw["General Liability On File"]));
    if (workersCompOnFile === undefined) addError("Workers Comp On File", "Workers Comp On File must be Yes or No.", cellToString(raw["Workers Comp On File"]));
    if (generalLiabilityExpiration === undefined) addError("General Liability Expiration Date", "General Liability Expiration Date is not a valid date.", cellToString(raw["General Liability Expiration Date"]));
    if (workersCompExpiration === undefined) addError("Workers Comp Expiration Date", "Workers Comp Expiration Date is not a valid date.", cellToString(raw["Workers Comp Expiration Date"]));

    const normalizedName = normalizeCompanyName(companyName);
    const contractorExists = reference.contractorsByName.has(normalizedName) || contractorsCreatedInFile.has(normalizedName);
    if (companyName && !contractorExists) addError("Company Name", "No matching contractor found.", companyName);

    row.data = {
      company_name: companyName,
      certificate_on_file: coiOnFile ?? false,
      general_liability_on_file: generalLiabilityOnFile ?? false,
      general_liability_expiration_date: generalLiabilityExpiration || null,
      workers_comp_on_file: workersCompOnFile ?? false,
      workers_comp_expiration_date: workersCompExpiration || null,
    };

    const existingContractor = reference.contractorsByName.get(normalizedName);
    const plannedAction: ImportAction = existingContractor && reference.contractorsWithInsurance.has(existingContractor.id) ? "Update" : "Create";

    return finalizeRow(row, plannedAction);
  });
}

function buildTieredSubsPreview(rows: RawRow[], reference: ReferenceData, contractorsCreatedInFile: Set<string>): ImportPreviewRow[] {
  const seenActiveKeys = new Set<string>();
  return rows.map((raw, index) => {
    const rowNumber = excelRowNumber(index);
    const parentName = cellToString(raw["Parent Company Name"]);
    const subName = cellToString(raw["Tiered Sub Company Name"]);
    const identifier = parentName || `Row ${rowNumber}`;
    const { row, addError } = makeRow("Tiered Subs", rowNumber, identifier, {});

    const assignedDate = toDateString(raw["Assigned Date"]);
    const active = toYesNoBoolean(raw["Active"]) ?? true;

    if (!parentName) addError("Parent Company Name", "Parent Company Name is required.");
    if (!subName) addError("Tiered Sub Company Name", "Tiered Sub Company Name is required.");
    if (assignedDate === undefined) addError("Assigned Date", "Assigned Date is not a valid date.", cellToString(raw["Assigned Date"]));

    const normalizedParent = normalizeCompanyName(parentName);
    const normalizedSub = normalizeCompanyName(subName);
    if (parentName && subName && normalizedParent === normalizedSub) {
      addError("Tiered Sub Company Name", "A contractor cannot be linked to itself.");
    }

    const parentExists = reference.contractorsByName.has(normalizedParent) || contractorsCreatedInFile.has(normalizedParent);
    const subExists = reference.contractorsByName.has(normalizedSub) || contractorsCreatedInFile.has(normalizedSub);
    if (parentName && !parentExists) addError("Parent Company Name", "No matching contractor found.", parentName);
    if (subName && !subExists) addError("Tiered Sub Company Name", "No matching contractor found.", subName);

    row.data = { parent_company_name: parentName, tiered_sub_company_name: subName, assigned_date: assignedDate || null, active };

    let plannedAction: ImportAction = "Create";
    const parent = reference.contractorsByName.get(normalizedParent);
    const sub = reference.contractorsByName.get(normalizedSub);
    if (parent && sub) {
      const key = tieredSubKey(parent.id, sub.id);
      if (active && (reference.activeTieredSubKeys.has(key) || seenActiveKeys.has(key))) {
        plannedAction = "Skip";
        if (row.errors.length === 0) addError("Active", "An active Tiered Sub relationship already exists.");
      } else if (reference.inactiveTieredSubKeys.has(key)) {
        plannedAction = "Update";
      }
      if (active) seenActiveKeys.add(key);
    }

    return finalizeRow(row, plannedAction);
  });
}

function buildFollowUpsPreview(rows: RawRow[], reference: ReferenceData, contractorsCreatedInFile: Set<string>): ImportPreviewRow[] {
  return rows.map((raw, index) => {
    const rowNumber = excelRowNumber(index);
    const companyName = cellToString(raw["Company Name"]);
    const identifier = companyName || `Row ${rowNumber}`;
    const { row, addError } = makeRow("Follow-Ups", rowNumber, identifier, {});

    const followupDate = toDateString(raw["Follow-Up Date"]);
    const method = cellToString(raw["Method"]);
    const status = cellToString(raw["Status"]) || "Open";
    const subject = cellToString(raw["Subject"]);
    const relatedComplianceType = cellToString(raw["Related Compliance Type"]) || null;

    if (!companyName) addError("Company Name", "Company Name is required.");
    if (followupDate === undefined || !followupDate) addError("Follow-Up Date", "Follow-Up Date is required and must be valid.", cellToString(raw["Follow-Up Date"]));
    if (!FOLLOWUP_METHOD_VALUES.includes(method as (typeof FOLLOWUP_METHOD_VALUES)[number])) {
      addError("Method", `Method must be one of: ${FOLLOWUP_METHOD_VALUES.join(", ")}.`, method);
    }
    if (!FOLLOWUP_STATUS_VALUES.includes(status as (typeof FOLLOWUP_STATUS_VALUES)[number])) {
      addError("Status", `Status must be one of: ${FOLLOWUP_STATUS_VALUES.join(", ")}.`, status);
    }
    if (!subject) addError("Subject", "Subject is required.");
    if (relatedComplianceType && !COMPLIANCE_TYPE_NAMES.includes(relatedComplianceType as (typeof COMPLIANCE_TYPE_NAMES)[number])) {
      addError("Related Compliance Type", `Related Compliance Type must be one of: ${COMPLIANCE_TYPE_NAMES.join(", ")}.`, relatedComplianceType);
    }

    const normalizedName = normalizeCompanyName(companyName);
    const contractorExists = reference.contractorsByName.has(normalizedName) || contractorsCreatedInFile.has(normalizedName);
    if (companyName && !contractorExists) addError("Company Name", "No matching contractor found.", companyName);

    row.data = {
      company_name: companyName,
      followup_date: followupDate || null,
      followup_method: method,
      status,
      related_compliance_type: relatedComplianceType,
      subject,
      notes: cellToString(raw["Notes"]) || null,
    };

    return finalizeRow(row, "Create");
  });
}

export function buildPreview(fileName: string, sheets: Partial<Record<ImportSheetName, RawRow[]>>, reference: ReferenceData): ImportPreviewResult {
  const rowsBySheet = {} as Record<ImportSheetName, ImportPreviewRow[]>;

  const contractorRows = sheets["Contractors"] ?? [];
  const projectRows = sheets["Projects"] ?? [];

  rowsBySheet["Projects"] = buildProjectsPreview(projectRows, reference);
  rowsBySheet["Contractors"] = buildContractorsPreview(contractorRows, reference);

  const contractorsCreatedInFile = new Set<string>();
  for (const row of rowsBySheet["Contractors"]) {
    if (row.action === "Create") contractorsCreatedInFile.add(normalizeCompanyName(String(row.data.company_name)));
  }
  const projectsCreatedInFile = new Set<string>();
  for (const row of rowsBySheet["Projects"]) {
    if (row.action === "Create") projectsCreatedInFile.add(String(row.data.project_number).trim().toLowerCase());
  }

  rowsBySheet["Project Assignments"] = buildProjectAssignmentsPreview(sheets["Project Assignments"] ?? [], reference, contractorsCreatedInFile, projectsCreatedInFile);
  rowsBySheet["Compliance Records"] = buildComplianceRecordsPreview(sheets["Compliance Records"] ?? [], reference, contractorsCreatedInFile);
  rowsBySheet["Insurance"] = buildInsurancePreview(sheets["Insurance"] ?? [], reference, contractorsCreatedInFile);
  rowsBySheet["Tiered Subs"] = buildTieredSubsPreview(sheets["Tiered Subs"] ?? [], reference, contractorsCreatedInFile);
  rowsBySheet["Follow-Ups"] = buildFollowUpsPreview(sheets["Follow-Ups"] ?? [], reference, contractorsCreatedInFile);

  const summaries: WorksheetSummary[] = SUPPORTED_SHEETS.map((worksheet) => {
    const sheetRows = rowsBySheet[worksheet] ?? [];
    return {
      worksheet,
      totalRows: sheetRows.length,
      validRows: sheetRows.filter((row) => row.action !== "Error").length,
      newRecords: sheetRows.filter((row) => row.action === "Create").length,
      updateRecords: sheetRows.filter((row) => row.action === "Update").length,
      skippedRows: sheetRows.filter((row) => row.action === "Skip").length,
      errorRows: sheetRows.filter((row) => row.action === "Error").length,
    };
  });

  return { fileName, summaries, rowsBySheet };
}

// ---------- import execution ----------

async function importProjects(rows: ImportPreviewRow[]): Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }> {
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: ImportRowError[] = [];

  for (const row of rows) {
    if (row.action === "Error" || row.action === "Skip") continue;
    const data = row.data as { project_number: string; project_name: string; status: string };
    try {
      const { data: existing } = await supabase.from("projects").select("id").eq("project_number", data.project_number).maybeSingle();
      if (existing) {
        const { error } = await supabase.from("projects").update({ project_name: data.project_name, status: data.status }).eq("id", existing.id);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase.from("projects").insert({ project_number: data.project_number, project_name: data.project_name, status: data.status });
        if (error) throw error;
        created += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({ worksheet: "Projects", rowNumber: row.rowNumber, identifier: row.identifier, field: "Project Number", message: error instanceof Error ? error.message : "Unable to import row." });
    }
  }

  return { created, updated, failed, errors };
}

async function importContractors(rows: ImportPreviewRow[]): Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }> {
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: ImportRowError[] = [];

  for (const row of rows) {
    if (row.action === "Error" || row.action === "Skip") continue;
    const data = row.data as {
      company_name: string;
      trade: string | null;
      contact_name: string | null;
      email: string | null;
      phone: string | null;
      notes: string | null;
      external_id: string | null;
      legacy_id: string | null;
      active: boolean;
    };
    try {
      let existingId: number | null = null;
      if (data.external_id) {
        const { data: match } = await supabase.from("contractors").select("id").eq("external_id", data.external_id).maybeSingle();
        existingId = match?.id ?? null;
      }
      if (!existingId) {
        const { data: matches } = await supabase.from("contractors").select("id, company_name");
        const normalized = normalizeCompanyName(data.company_name);
        existingId = (matches ?? []).find((candidate) => normalizeCompanyName(candidate.company_name) === normalized)?.id ?? null;
      }

      if (existingId) {
        const { error } = await supabase.from("contractors").update(data).eq("id", existingId);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase.from("contractors").insert(data);
        if (error) throw error;
        created += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({ worksheet: "Contractors", rowNumber: row.rowNumber, identifier: row.identifier, field: "Company Name", message: error instanceof Error ? error.message : "Unable to import row." });
    }
  }

  return { created, updated, failed, errors };
}

async function resolveContractorId(companyName: string): Promise<number | null> {
  const { data } = await supabase.from("contractors").select("id, company_name");
  const normalized = normalizeCompanyName(companyName);
  return (data ?? []).find((candidate) => normalizeCompanyName(candidate.company_name) === normalized)?.id ?? null;
}

async function importProjectAssignments(rows: ImportPreviewRow[]): Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }> {
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: ImportRowError[] = [];

  for (const row of rows) {
    if (row.action === "Error" || row.action === "Skip") continue;
    const data = row.data as { company_name: string; project_number: string; assigned_date: string | null; active: boolean };
    try {
      const contractorId = await resolveContractorId(data.company_name);
      const { data: project } = await supabase.from("projects").select("id").eq("project_number", data.project_number).maybeSingle();
      if (!contractorId || !project) throw new Error("Contractor or project could not be resolved.");

      const { data: existing } = await supabase
        .from("contractor_projects")
        .select("id")
        .eq("contractor_id", contractorId)
        .eq("project_id", project.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("contractor_projects")
          .update({ active: data.active, assigned_date: data.assigned_date ?? undefined, removed_date: data.active ? null : new Date().toISOString().slice(0, 10) })
          .eq("id", existing.id);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase
          .from("contractor_projects")
          .insert({ contractor_id: contractorId, project_id: project.id, assigned_date: data.assigned_date ?? new Date().toISOString().slice(0, 10), active: data.active });
        if (error) throw error;
        created += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({ worksheet: "Project Assignments", rowNumber: row.rowNumber, identifier: row.identifier, field: "Company Name", message: error instanceof Error ? error.message : "Unable to import row." });
    }
  }

  return { created, updated, failed, errors };
}

async function importComplianceRecords(rows: ImportPreviewRow[]): Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }> {
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: ImportRowError[] = [];

  const { data: types } = await supabase.from("compliance_types").select("id, compliance_name");
  const typeIdByName = new Map((types ?? []).map((type) => [type.compliance_name, type.id] as const));

  for (const row of rows) {
    if (row.action === "Error" || row.action === "Skip") continue;
    const data = row.data as {
      company_name: string;
      compliance_type_name: string;
      registration_number: string | null;
      effective_date: string | null;
      expiration_date: string | null;
      verified_date: string | null;
      verified_by: string | null;
      verification_source: string | null;
      notes: string | null;
      active: boolean;
      is_current: boolean;
    };
    try {
      const contractorId = await resolveContractorId(data.company_name);
      const complianceTypeId = typeIdByName.get(data.compliance_type_name);
      if (!contractorId || !complianceTypeId) throw new Error("Contractor or compliance type could not be resolved.");

      const { data: existing } = await supabase
        .from("compliance_records")
        .select("id")
        .eq("contractor_id", contractorId)
        .eq("compliance_type_id", complianceTypeId)
        .eq("registration_number", data.registration_number ?? "")
        .eq("expiration_date", data.expiration_date ?? "")
        .maybeSingle();

      const payload = {
        contractor_id: contractorId,
        compliance_type_id: complianceTypeId,
        registration_number: data.registration_number,
        effective_date: data.effective_date,
        expiration_date: data.expiration_date,
        verified_date: data.verified_date,
        verified_by: data.verified_by,
        verification_source: data.verification_source,
        notes: data.notes,
        active: data.active,
        is_current: data.is_current,
      };

      if (existing) {
        const { error } = await supabase.from("compliance_records").update(payload).eq("id", existing.id);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase.from("compliance_records").insert(payload);
        if (error) throw error;
        created += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({ worksheet: "Compliance Records", rowNumber: row.rowNumber, identifier: row.identifier, field: "Company Name", message: error instanceof Error ? error.message : "Unable to import row." });
    }
  }

  return { created, updated, failed, errors };
}

async function importInsurance(rows: ImportPreviewRow[]): Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }> {
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: ImportRowError[] = [];

  for (const row of rows) {
    if (row.action === "Error" || row.action === "Skip") continue;
    const data = row.data as {
      company_name: string;
      certificate_on_file: boolean;
      general_liability_on_file: boolean;
      general_liability_expiration_date: string | null;
      workers_comp_on_file: boolean;
      workers_comp_expiration_date: string | null;
    };
    try {
      const contractorId = await resolveContractorId(data.company_name);
      if (!contractorId) throw new Error("Contractor could not be resolved.");

      const { data: existing } = await supabase.from("contractor_insurance").select("contractor_id").eq("contractor_id", contractorId).maybeSingle();

      const payload = {
        certificate_on_file: data.certificate_on_file,
        general_liability_on_file: data.general_liability_on_file,
        general_liability_expiration_date: data.general_liability_expiration_date,
        workers_comp_on_file: data.workers_comp_on_file,
        workers_comp_expiration_date: data.workers_comp_expiration_date,
      };

      const { error } = await supabase.from("contractor_insurance").upsert({ contractor_id: contractorId, ...payload }, { onConflict: "contractor_id" });
      if (error) throw error;

      const { error: historyError } = await supabase.from("contractor_insurance_history").insert({
        contractor_id: contractorId,
        coi_on_file: data.certificate_on_file,
        general_liability_on_file: data.general_liability_on_file,
        general_liability_expiration_date: data.general_liability_expiration_date,
        workers_comp_on_file: data.workers_comp_on_file,
        workers_comp_expiration_date: data.workers_comp_expiration_date,
      });
      if (historyError) throw historyError;

      if (existing) updated += 1;
      else created += 1;
    } catch (error) {
      failed += 1;
      errors.push({ worksheet: "Insurance", rowNumber: row.rowNumber, identifier: row.identifier, field: "Company Name", message: error instanceof Error ? error.message : "Unable to import row." });
    }
  }

  return { created, updated, failed, errors };
}

async function importTieredSubs(rows: ImportPreviewRow[]): Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }> {
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: ImportRowError[] = [];

  for (const row of rows) {
    if (row.action === "Error" || row.action === "Skip") continue;
    const data = row.data as { parent_company_name: string; tiered_sub_company_name: string; assigned_date: string | null; active: boolean };
    try {
      const parentId = await resolveContractorId(data.parent_company_name);
      const subId = await resolveContractorId(data.tiered_sub_company_name);
      if (!parentId || !subId) throw new Error("Parent or Tiered Sub contractor could not be resolved.");
      if (parentId === subId) throw new Error("A contractor cannot be linked to itself.");

      const { data: existing } = await supabase
        .from("contractor_tiered_subs")
        .select("id, active")
        .eq("contractor_id", parentId)
        .eq("tiered_sub_contractor_id", subId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("contractor_tiered_subs")
          .update({ active: data.active, assigned_date: data.assigned_date ?? undefined, removed_date: data.active ? null : new Date().toISOString().slice(0, 10) })
          .eq("id", existing.id);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase
          .from("contractor_tiered_subs")
          .insert({ contractor_id: parentId, tiered_sub_contractor_id: subId, assigned_date: data.assigned_date ?? new Date().toISOString().slice(0, 10), active: data.active });
        if (error) throw error;
        created += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({ worksheet: "Tiered Subs", rowNumber: row.rowNumber, identifier: row.identifier, field: "Parent Company Name", message: error instanceof Error ? error.message : "Unable to import row." });
    }
  }

  return { created, updated, failed, errors };
}

async function importFollowUps(rows: ImportPreviewRow[]): Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }> {
  let created = 0;
  const updated = 0;
  let failed = 0;
  const errors: ImportRowError[] = [];

  const { data: types } = await supabase.from("compliance_types").select("id, compliance_name");
  const typeIdByName = new Map((types ?? []).map((type) => [type.compliance_name, type.id] as const));

  for (const row of rows) {
    if (row.action === "Error" || row.action === "Skip") continue;
    const data = row.data as {
      company_name: string;
      followup_date: string | null;
      followup_method: string;
      status: string;
      related_compliance_type: string | null;
      subject: string;
      notes: string | null;
    };
    try {
      const contractorId = await resolveContractorId(data.company_name);
      if (!contractorId) throw new Error("Contractor could not be resolved.");

      let complianceRecordId: number | null = null;
      if (data.related_compliance_type) {
        const complianceTypeId = typeIdByName.get(data.related_compliance_type);
        if (complianceTypeId) {
          const { data: record } = await supabase
            .from("compliance_records")
            .select("id")
            .eq("contractor_id", contractorId)
            .eq("compliance_type_id", complianceTypeId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          complianceRecordId = record?.id ?? null;
        }
      }

      const { error } = await supabase.from("contractor_followups").insert({
        contractor_id: contractorId,
        compliance_record_id: complianceRecordId,
        followup_date: data.followup_date,
        followup_method: data.followup_method,
        subject: data.subject,
        notes: data.notes,
        status: data.status,
      });
      if (error) throw error;
      created += 1;
    } catch (error) {
      failed += 1;
      errors.push({ worksheet: "Follow-Ups", rowNumber: row.rowNumber, identifier: row.identifier, field: "Company Name", message: error instanceof Error ? error.message : "Unable to import row." });
    }
  }

  return { created, updated, failed, errors };
}

export async function runImport(
  preview: ImportPreviewResult,
  onProgress?: (worksheet: ImportSheetName) => void
): Promise<ImportRunResult> {
  const result: ImportRunResult = { totalProcessed: 0, successful: 0, created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

  const importers: Record<ImportSheetName, (rows: ImportPreviewRow[]) => Promise<{ created: number; updated: number; failed: number; errors: ImportRowError[] }>> = {
    Projects: importProjects,
    Contractors: importContractors,
    "Project Assignments": importProjectAssignments,
    "Compliance Records": importComplianceRecords,
    Insurance: importInsurance,
    "Tiered Subs": importTieredSubs,
    "Follow-Ups": importFollowUps,
  };

  for (const worksheet of SUPPORTED_SHEETS) {
    const rows = preview.rowsBySheet[worksheet] ?? [];
    onProgress?.(worksheet);
    const skipped = rows.filter((row) => row.action === "Skip").length;
    const errorRows = rows.filter((row) => row.action === "Error").length;
    result.skipped += skipped;
    result.totalProcessed += rows.length;

    const outcome = await importers[worksheet](rows);
    result.created += outcome.created;
    result.updated += outcome.updated;
    result.failed += outcome.failed + errorRows;
    result.successful += outcome.created + outcome.updated;
    result.errors.push(...outcome.errors);
  }

  return result;
}

export async function recordImportHistory(fileName: string, preview: ImportPreviewResult, result: ImportRunResult): Promise<void> {
  const totalRows = preview.summaries.reduce((sum, summary) => sum + summary.totalRows, 0);
  await supabase.from("import_history").insert({
    file_name: fileName,
    imported_rows: totalRows,
    successful_rows: result.successful,
    failed_rows: result.failed,
    notes: `Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`,
  });
}

export function generateErrorWorkbook(errors: ImportRowError[]): Blob {
  const rows = errors.map((error) => ({
    Worksheet: error.worksheet,
    "Row Number": error.rowNumber,
    "Company Name or Project Number": error.identifier,
    Field: error.field,
    "Original Value": error.originalValue ?? "",
    "Error Message": error.message,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Errors");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
