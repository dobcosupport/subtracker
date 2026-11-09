"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { getContractors } from "@/services/contractors";
import {
  getCompanyComplianceStatus,
  getDashboardData,
  type CompanyComplianceStatus,
  type DashboardRecord,
} from "@/services/dashboard";
import { getFollowups } from "@/services/followups";
import { getReportProjectContext, getComplianceReportAssessment, complianceCompanies, filterComplianceCompanies, type AssessmentProject } from "@/services/project-compliance-assessment";
import ComplianceReport from "@/components/reports/ComplianceReport";
import { complianceReportPdf } from "@/services/compliance-report-pdf";
import { itemReportPdf } from "@/services/item-report-pdf";
import { itemReportColor, itemReportColumns, itemReportExpiration, upcomingStatuses, type ItemReport } from "@/services/item-reports";
import { finalReportColumns, finalReportColor, finalReportNotes, followupScopeLimitation, selectedProjectSummary, type FinalReport } from "@/services/final-reports";
import { finalReportPdf } from "@/services/final-report-pdf";
import type { ComplianceStatus, ContractorFollowup } from "@/types/database";
import DashboardExportDialog from "@/components/exports/DashboardExportDialog";
import Style3Icon from "@/components/style3/Style3Icon";
import styles from "./reports.module.css";

const reports = [
  { id: "compliance-status", label: "Compliance Status" },
  { id: "missing-information", label: "Missing Information" },
  { id: "expired-items", label: "Expired Items" },
  { id: "upcoming-expirations", label: "Upcoming Expirations" },
  { id: "project-compliance", label: "Project Compliance" },
  { id: "insurance", label: "Insurance" },
  { id: "follow-up", label: "Follow-Up" },
] as const;

const followupStatuses = ["Open", "Waiting Response", "Resolved", "Closed"] as const;
type ReportType = (typeof reports)[number]["id"];
type ReportColumnKey =
  | "companyName" | "item" | "status" | "expirationDate" | "daysRemaining"
  | "assignedProjects" | "issues" | "complianceIssues" | "insuranceIssues"
  | "followupDate" | "lastFollowup" | "method" | "subject" | "notes";
type ReportRow = {
  id: string;
  contractorId: number;
  companyName: string;
  item: string;
  status: string;
  expirationDate: string | null;
  daysRemaining: number | null;
  assignedProjects: string;
  issues: string;
  complianceIssues: string;
  insuranceIssues: string;
  followupDate: string | null;
  lastFollowup: string | null;
  method: string;
  subject: string;
  notes: string;
  severity?: string;
};
type ReportColumn = { key: ReportColumnKey; label: string };
type FollowupReportRow = ContractorFollowup & { companyName: string };

const columnsByReport: Record<ReportType, ReportColumn[]> = {
  "compliance-status": [
    { key: "companyName", label: "Company Name" },
    { key: "status", label: "Status" },
    { key: "issues", label: "Issues" },
    { key: "assignedProjects", label: "Assigned Projects" },
  ],
  ...itemReportColumns,
  ...finalReportColumns,
};

const statusStyles: Record<string, string> = {
  Compliant: "bg-emerald-100 text-emerald-700",
  Active: "bg-emerald-100 text-emerald-700",
  Expiring: "bg-amber-100 text-amber-700",
  "90 Day": "bg-amber-100 text-amber-700",
  "60 Day": "bg-orange-100 text-orange-700",
  "30 Day": "bg-red-100 text-red-700",
  Expired: "bg-red-100 text-red-700",
  "Non-Compliant": "bg-red-100 text-red-700",
  "Missing Information": "bg-sky-100 text-sky-700",
  Open: "bg-sky-100 text-sky-700",
  "Waiting Response": "bg-amber-100 text-amber-700",
  Resolved: "bg-emerald-100 text-emerald-700",
  Closed: "bg-slate-100 text-slate-600",
};
const issueStatuses = new Set<ComplianceStatus>(["Expired", "30 Day", "60 Day", "90 Day", "Missing Information"]);

function formatDate(date: string | null): string {
  if (!date) return "";
  const [year, month, day] = date.split("-");
  return `${month}/${day}/${year}`;
}

function buildIssues(records: DashboardRecord[]): string {
  return records
    .filter((record) => issueStatuses.has(record.calculated_status))
    .map((record) => `${record.compliance_name}: ${record.calculated_status}`)
    .join("; ");
}

function isComplianceIssueRecord(record: DashboardRecord): boolean {
  return record.record_key.startsWith("compliance:") || record.compliance_name === "Active Compliance Records";
}

function isInsuranceIssueRecord(record: DashboardRecord): boolean {
  return record.record_key.startsWith("insurance:") && record.compliance_name !== "Active Compliance Records";
}

function toExportRows(rows: ReportRow[], columns: ReportColumn[]): Record<string, string | number>[] {
  return rows.map((row) => Object.fromEntries(
    columns.map((column) => {
      const value = row[column.key];
      if (["expirationDate", "followupDate", "lastFollowup"].includes(column.key)) {
        return [column.label, formatDate(value as string | null)];
      }
      return [column.label, value ?? ""];
    })
  ));
}

export default function ReportsPage() {
  const [records, setRecords] = useState<DashboardRecord[]>([]);
  const [followups, setFollowups] = useState<FollowupReportRow[]>([]);
  const [projectsByContractor, setProjectsByContractor] = useState<Map<number, string[]>>(new Map());
  const [projectContext, setProjectContext] = useState<{ projects: AssessmentProject[]; assignments: { contractor_id: number; project_id: number }[] }>({ projects: [], assignments: [] });
  const [selectedReport, setSelectedReport] = useState<ReportType>("compliance-status");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All statuses");
  const [projectFilter, setProjectFilter] = useState("All projects");
  const [sortKey, setSortKey] = useState<ReportColumnKey>("companyName");
  const [sortAscending, setSortAscending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [customExport, setCustomExport] = useState<{ ids: number[]; filter: string; search: string } | null>(null);
  const [compliance, setCompliance] = useState<{ scope: string; companies: ReturnType<typeof complianceCompanies> } | null>(null);
  const [complianceError, setComplianceError] = useState<{ scope: string; message: string } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const itemReport: ItemReport | null = selectedReport === "missing-information" || selectedReport === "expired-items"
    || selectedReport === "upcoming-expirations" ? selectedReport : null;
  const finalReport: FinalReport | null = selectedReport === "project-compliance" || selectedReport === "insurance"
    || selectedReport === "follow-up" ? selectedReport : null;
  const followupScopeBlocked = selectedReport === "follow-up" && projectFilter !== "All projects";

  useEffect(() => {
    if (!exportOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [exportOpen]);

  useEffect(() => {
    const controller = new AbortController();
    const loadReports = async () => {
      const [dashboardResult, contractorResult, followupResult, context] = await Promise.all([
        getDashboardData(),
        getContractors(),
        getFollowups(),
        getReportProjectContext(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const loadError = dashboardResult.error || contractorResult.error || followupResult.error;
      if (loadError) {
        setError(loadError.message || "Unable to load report data.");
        setLoading(false);
        return;
      }

      const contractorsById = new Map((contractorResult.data ?? []).map((contractor) => [contractor.id, contractor.company_name]));
      setRecords(dashboardResult.data?.records ?? []);
      setProjectContext(context);
      setProjectsByContractor(dashboardResult.data?.projectNumbersByContractor ?? new Map());
      setFollowups((followupResult.data ?? []).map((followup) => ({
        ...followup,
        companyName: contractorsById.get(followup.contractor_id) ?? "Unknown contractor",
      })));
      setError(null);
      setLoading(false);
    };

    void loadReports().catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Unable to load Reports project context.");
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedReport !== "compliance-status" && !((itemReport || selectedReport === "project-compliance")
      && !["All projects", "Unassigned"].includes(projectFilter))) return;
    const controller = new AbortController();
    const scope = projectFilter === "All projects" ? "all" : projectFilter === "Unassigned" ? "unassigned" : Number(projectFilter);
    void getComplianceReportAssessment(scope, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setCompliance({ scope: projectFilter, companies: complianceCompanies(result) });
        setComplianceError(null);
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setComplianceError({ scope: projectFilter, message: reason instanceof Error ? reason.message : "Compliance assessment unavailable." });
    });
    return () => controller.abort();
  }, [selectedReport, projectFilter, itemReport]);

  const expirationProjection = useMemo(() => {
    try {
      return { values: new Map(records.map(record => [record.record_key,
        itemReport === "expired-items" || itemReport === "upcoming-expirations" || selectedReport === "insurance"
          ? itemReportExpiration(record, new Date().toISOString().slice(0, 10))
          : { status: record.calculated_status, daysRemaining: record.days_remaining }])), error: null };
    } catch (reason: unknown) {
      return { values: new Map<string, { status: string; daysRemaining: number | null }>(),
        error: reason instanceof Error ? reason.message : "Report expiration data is invalid." };
    }
  }, [records, itemReport, selectedReport]);

  const reportRows = useMemo<ReportRow[]>(() => {
    const recordsByContractor = new Map<number, DashboardRecord[]>();
    records.forEach((record) => {
      const contractorRecords = recordsByContractor.get(record.contractor_id) ?? [];
      contractorRecords.push(record);
      recordsByContractor.set(record.contractor_id, contractorRecords);
    });

    const makeItemRow = (record: DashboardRecord): ReportRow => ({
      id: record.record_key,
      contractorId: record.contractor_id,
      companyName: record.company_name,
      item: record.compliance_name,
      status: expirationProjection.values.get(record.record_key)?.status ?? record.calculated_status,
      expirationDate: record.expiration_date,
      daysRemaining: expirationProjection.values.get(record.record_key)?.daysRemaining ?? record.days_remaining,
      assignedProjects: (projectsByContractor.get(record.contractor_id) ?? []).join(", "),
      issues: `${record.compliance_name}: ${record.calculated_status}`,
      complianceIssues: isComplianceIssueRecord(record) && issueStatuses.has(record.calculated_status)
        ? `${record.compliance_name}: ${record.calculated_status}`
        : "",
      insuranceIssues: isInsuranceIssueRecord(record) && issueStatuses.has(record.calculated_status)
        ? `${record.compliance_name}: ${record.calculated_status}`
        : "",
      followupDate: null,
      lastFollowup: null,
      method: "",
      subject: "",
      notes: "",
    });

    const itemRows = records.map(makeItemRow);
    if (selectedReport === "expired-items") return itemRows.filter((row) => row.status === "Expired");
    if (selectedReport === "upcoming-expirations") return itemRows.filter((row) => upcomingStatuses.includes(row.status));
    if (selectedReport === "missing-information") return itemRows.filter((row) => row.status === "Missing Information");
    if (selectedReport === "insurance") return itemRows.filter((row) => row.id.startsWith("insurance:"));

    if (selectedReport === "follow-up") {
      const lastFollowupByContractor = new Map<number, string>();
      followups.forEach((followup) => {
        const previousDate = lastFollowupByContractor.get(followup.contractor_id);
        if (!previousDate || followup.followup_date > previousDate) {
          lastFollowupByContractor.set(followup.contractor_id, followup.followup_date);
        }
      });
      return followups.map((followup) => ({
        id: `followup:${followup.id}`,
        contractorId: followup.contractor_id,
        companyName: followup.companyName,
        item: followup.subject,
        status: followup.status,
        expirationDate: null,
        daysRemaining: null,
        assignedProjects: (projectsByContractor.get(followup.contractor_id) ?? []).join(", "),
        issues: "",
        complianceIssues: "",
        insuranceIssues: "",
        followupDate: followup.followup_date,
        lastFollowup: lastFollowupByContractor.get(followup.contractor_id) ?? followup.followup_date,
        method: followup.followup_method,
        subject: followup.subject,
        notes: followup.notes ?? "",
      }));
    }

    if (selectedReport === "project-compliance" && !["All projects", "Unassigned"].includes(projectFilter)) {
      return compliance?.scope === projectFilter ? compliance.companies.map(company => ({
        ...makeItemRow({ record_key: `contractor:${company.id}`, contractor_id: company.id, company_name: company.name,
          compliance_name: "Overall compliance", calculated_status: "Active", registration_number: null,
          expiration_date: null, days_remaining: null }),
        ...selectedProjectSummary(company, records, new Date().toISOString().slice(0, 10)),
      })) : [];
    }
    return [...recordsByContractor.entries()].map(([contractorId, contractorRecords]) => {
      const firstRecord = contractorRecords[0];
      const companyStatus: CompanyComplianceStatus = getCompanyComplianceStatus(contractorRecords);
      return {
        id: `contractor:${contractorId}`,
        contractorId,
        companyName: firstRecord.company_name,
        item: "Overall compliance",
        status: companyStatus,
        expirationDate: null,
        daysRemaining: null,
        assignedProjects: (projectsByContractor.get(contractorId) ?? []).join(", "),
        issues: buildIssues(contractorRecords),
        complianceIssues: buildIssues(contractorRecords.filter(isComplianceIssueRecord)),
        insuranceIssues: buildIssues(contractorRecords.filter(isInsuranceIssueRecord)),
        followupDate: null,
        lastFollowup: null,
        method: "",
        subject: "",
        notes: "",
      } satisfies ReportRow;
    });
  }, [compliance, expirationProjection, followups, records, projectsByContractor, selectedReport, projectFilter]);

  const statusOptions = useMemo(() => selectedReport === "compliance-status"
    ? ["Current", "61-90 Days", "31-60 Days", "0-30 Days", "Expired", "Missing"]
    : selectedReport === "follow-up"
    ? [...followupStatuses]
    : [...new Set(reportRows.map((row) => row.status))].sort(), [reportRows, selectedReport]);
  const projectOptions = useMemo(() => [...projectContext.projects].sort((a, b) =>
    a.project_number.localeCompare(b.project_number, undefined, { numeric: true })), [projectContext.projects]);
  const selectedProject = projectContext.projects.find(project => String(project.id) === projectFilter);
  const projectLabel = selectedProject ? `${selectedProject.project_number} - ${selectedProject.project_name}` : projectFilter;
  const currentColumns = useMemo(() => selectedReport === "compliance-status"
    ? [{ key: "companyName", label: "Company Name" }, { key: "item", label: "Requirement" }, { key: "status", label: "Status" },
      { key: "expirationDate", label: "Expiration Date" }, { key: "issues", label: "Details" }] satisfies ReportColumn[]
    : columnsByReport[selectedReport], [selectedReport]);
  const visibleRows = useMemo(() => {
    if (followupScopeBlocked) return [];
    const term = search.trim().toLowerCase();
    return reportRows
      .filter((row) => statusFilter === "All statuses" || row.status === statusFilter)
      .filter((row) => projectFilter === "All projects"
        || (projectFilter === "Unassigned"
          ? !projectContext.assignments.some(assignment => assignment.contractor_id === row.contractorId)
          : projectContext.assignments.some(assignment => assignment.contractor_id === row.contractorId && String(assignment.project_id) === projectFilter)))
      .filter(row => !itemReport || !selectedProject
        || !["NJ BRC", "NJ PWC"].includes(row.item)
        || (compliance?.scope === projectFilter && compliance.companies.some(company => company.id === row.contractorId
          && company.requirements.some(requirement => requirement.requirement === row.item && requirement.applicable))))
      .map(row => selectedProject ? { ...row, assignedProjects: selectedReport === "compliance-status" ? "" : projectLabel } : row)
      .filter((row) => !term || currentColumns.some((column) => String(row[column.key] ?? "").toLowerCase().includes(term)))
      .sort((left, right) => {
        const leftValue = left[sortKey];
        const rightValue = right[sortKey];
        const comparison = typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue ?? "").localeCompare(String(rightValue ?? ""), undefined, { numeric: true, sensitivity: "base" });
        return sortAscending ? comparison : -comparison;
      });
  }, [compliance, currentColumns, followupScopeBlocked, itemReport, projectContext.assignments, projectFilter, projectLabel, reportRows, search, selectedProject, selectedReport, sortAscending, sortKey, statusFilter]);

  const handleSort = (key: ReportColumnKey) => {
    if (sortKey === key) setSortAscending((ascending) => !ascending);
    else {
      setSortKey(key);
      setSortAscending(true);
    }
  };

  const isCompliance = selectedReport === "compliance-status";
  const usesAssessment = isCompliance || ((!!itemReport || selectedReport === "project-compliance") && !!selectedProject);
  const assessmentError = (usesAssessment && complianceError?.scope === projectFilter ? complianceError.message : null) || expirationProjection.error;
  const assessmentLoading = usesAssessment && compliance?.scope !== projectFilter && !assessmentError;
  const scopedCompanies = useMemo(() => compliance?.scope === projectFilter && !assessmentError
    ? filterComplianceCompanies(compliance.companies, search, statusFilter).sort((left, right) => {
      const comparison = (sortKey === "status" ? left.state.localeCompare(right.state) : left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
      return sortAscending ? comparison : -comparison;
    }) : [], [compliance, projectFilter, search, statusFilter, assessmentError, sortKey, sortAscending]);
  const exportRowsSource: ReportRow[] = isCompliance ? scopedCompanies.flatMap(company => company.requirements.map(requirement => ({
    id: `${company.id}:${requirement.requirement}`, contractorId: company.id, companyName: company.name,
    item: requirement.requirement, status: requirement.status, expirationDate: requirement.expirationDate,
    daysRemaining: requirement.daysRemaining, issues: requirement.detail, assignedProjects: "", complianceIssues: "",
    insuranceIssues: "", followupDate: null, lastFollowup: null, method: "", subject: "", notes: "",
  }))) : visibleRows;
  const exportDisabled = loading || assessmentLoading || !!assessmentError || exportRowsSource.length === 0;
  const reportName = reports.find((report) => report.id === selectedReport)?.label ?? "Report";

  const openCustomExport = () => {
    const ids = [...new Set(exportRowsSource.map((row) => row.contractorId))];
    if (followupScopeBlocked || loading || error || assessmentLoading || assessmentError || (!["All projects", "Unassigned"].includes(projectFilter) && !selectedProject)
      || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      setError("Unable to export this report population. Reload Reports and try again.");
      return;
    }
    setExportOpen(false);
    setCustomExport({ ids, filter: `${reportName}; Status: ${statusFilter}; Project: ${projectLabel}${selectedProject ? ` (ID ${selectedProject.id})` : ""}`, search });
  };

  const handleExport = (format: "xlsx" | "pdf" | "csv") => {
    const reportName = reports.find((report) => report.id === selectedReport)?.label ?? "Report";
    const exportDate = new Date().toISOString().slice(0, 10);
    const filename = `${reportName.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")}_Report_${exportDate}`;
    const exportRows = toExportRows(exportRowsSource, currentColumns).map(row =>
      selectedProject ? { "Report Project": projectLabel, ...row } : row);

    if (format === "pdf") {
      if (isCompliance) {
        try {
          if (exportDisabled || (!["All projects", "Unassigned"].includes(projectFilter) && !selectedProject)) {
            throw new Error("Compliance PDF scope is unavailable. Reload Reports; no broader scope was substituted.");
          }
          complianceReportPdf({
            companies: scopedCompanies,
            scope: selectedProject ? { kind: "project", project: selectedProject }
              : { kind: projectFilter === "Unassigned" ? "unassigned" : "all" },
            status: statusFilter, search,
          }).save(`${filename}.pdf`);
        } catch (reason: unknown) {
          setError(reason instanceof Error ? reason.message : "Unable to generate Compliance PDF.");
        }
        return;
      }
      if (itemReport) {
        try {
          if (exportDisabled || (!["All projects", "Unassigned"].includes(projectFilter) && !selectedProject)) {
            throw new Error(`${reportName} PDF scope is unavailable. Reload Reports.`);
          }
          itemReportPdf({
            report: itemReport,
            rows: visibleRows,
            scope: selectedProject ? { kind: "project", project: selectedProject }
              : { kind: projectFilter === "Unassigned" ? "unassigned" : "all" },
            status: statusFilter, search,
          }).save(`${filename}.pdf`);
        } catch (reason: unknown) {
          setError(reason instanceof Error ? reason.message : `Unable to generate ${reportName} PDF.`);
        }
        return;
      }
      try {
        if (!finalReport || loading || error || assessmentLoading || assessmentError
          || (!["All projects", "Unassigned"].includes(projectFilter) && !selectedProject)) {
          throw new Error(`${reportName} PDF scope is unavailable. Reload Reports.`);
        }
        finalReportPdf({ report: finalReport, rows: visibleRows,
          scope: selectedProject ? { kind: "project", project: selectedProject }
            : { kind: projectFilter === "Unassigned" ? "unassigned" : "all" },
          search, status: statusFilter,
        }).save(`${filename}.pdf`);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : `Unable to generate ${reportName} PDF.`);
      }
      return;
    }

    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    if (format === "xlsx") {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, reportName.slice(0, 31));
      XLSX.writeFile(workbook, `${filename}.xlsx`);
      return;
    }

    const blob = new Blob([XLSX.utils.sheet_to_csv(worksheet)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filename}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className={styles.reports}>
      <div className={styles.content}>
        <div className={`${styles.heading} ${isCompliance || itemReport || finalReport ? styles.complianceHeading : ""}`}>
          <div>
            <p className={styles.eyebrow}>Reporting &amp; exports</p>
            <h1>{isCompliance ? "Compliance Status" : itemReport || finalReport ? reportName : "Reports"}</h1>
            <p>{isCompliance ? "Review contractor compliance by requirement. See what's current, what's expiring, and what needs attention."
              : itemReport === "missing-information" ? "Identify missing information in the selected report population and export the items that need attention."
                : itemReport === "expired-items" ? "Review expired items and their actual expiration dates in the selected report population."
                  : itemReport === "upcoming-expirations" ? "Review items expiring within 90 days and prioritize the next renewals."
                    : finalReport === "project-compliance" ? "Review contractor compliance and insurance observations in the selected project context."
                      : finalReport === "insurance" ? "Review MyCOI coverage observations and renewal dates for the selected contractor population."
                        : "Review contractor-level Follow-Ups without inferring project relationships."}</p>
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={openCustomExport} disabled={followupScopeBlocked || loading || !!error || assessmentLoading || !!assessmentError} className={styles.secondary}>Create Custom Export</button>
            <div className={styles.exportControl} ref={exportMenuRef}>
              <button type="button" onClick={() => setExportOpen((open) => !open)} disabled={loading || !!error || assessmentLoading || !!assessmentError} aria-expanded={exportOpen} aria-haspopup="menu" className={styles.primary}>
                <Style3Icon name="Import / Export" /> Export <span aria-hidden="true">▾</span>
              </button>
              {exportOpen ? (
                <div role="menu" className={styles.exportMenu}>
                  {([["xlsx", "Export to Excel (.xlsx)"], ["pdf", "Export to PDF (.pdf)"], ["csv", "Export to CSV (.csv)"]] as const).map(([format, label]) => (
                    <button key={format} type="button" role="menuitem" disabled={exportDisabled && !(format === "pdf" && followupScopeBlocked && !loading && !error)} onClick={() => { setExportOpen(false); handleExport(format); }} className="block w-full px-4 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                      {label}
                    </button>
                  ))}
                  <button type="button" role="menuitem" onClick={openCustomExport} disabled={followupScopeBlocked} className="block w-full border-t border-slate-200 px-4 py-2.5 text-left text-sm text-indigo-700 hover:bg-slate-50 disabled:opacity-50">Custom export / saved templates</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <section className={styles.categories} aria-label="Report categories">
          <div className={styles.tabs} role="tablist" aria-label="Reports">
            {reports.map((report) => (
              <button key={report.id} type="button" role="tab" aria-selected={selectedReport === report.id} onClick={() => { setSelectedReport(report.id); setStatusFilter("All statuses"); }}>
                {report.label}
              </button>
            ))}
          </div>
        </section>

        <section className={isCompliance || itemReport || finalReport ? styles.complianceWorkspace : styles.panel} aria-label={`${reportName} results`}>
          <div className={styles.filters}>
            <label>Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search report" aria-label="Search report" /></label>
            <label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by status">
              <option>All statuses</option>
              {statusOptions.map((status) => <option key={status}>{status}</option>)}
            </select></label>
            <label>Project<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="Filter by project">
              <option>All projects</option>
              <option>Unassigned</option>
              {projectOptions.map((project) => <option key={project.id} value={project.id}>{project.project_number} - {project.project_name}</option>)}
            </select></label>
          </div>
          {isCompliance ? <div className={styles.projectBanner}><span aria-hidden="true">▥</span><div><strong>{selectedProject ? projectLabel : projectFilter === "Unassigned" ? "Unassigned Contractors" : "All Projects"}</strong><p>{selectedProject ? "Project Compliance Report" : "Contractor Compliance Report"} · FEIN / NJ BRC / NJ PWC</p></div></div> : null}
          {itemReport ? <>
            <div className={styles.projectBanner}><Style3Icon name="Reports" /><div><strong>{selectedProject ? projectLabel : projectFilter === "Unassigned" ? "Unassigned Contractors" : "All Projects"}</strong><p>{reportName} Report</p></div></div>
            <div className={styles.itemSummary} aria-label={`${reportName} summary`} aria-live="polite">
              <strong>{assessmentLoading || assessmentError || loading ? "—" : visibleRows.length} {itemReport === "missing-information" ? "missing" : itemReport === "expired-items" ? "expired" : "expiring"} items</strong>
              <span>{assessmentLoading || assessmentError || loading ? "—" : new Set(visibleRows.map(row => row.contractorId)).size} contractors</span>
              <p>{itemReport === "missing-information" ? "Insurance entries identify absent MyCOI coverage data, not selected-project insurance requirements."
                : "Insurance entries are MyCOI coverage observations, not selected-project insurance requirements. Dates use inclusive calendar-day boundaries."}</p>
            </div>
          </> : null}
          {finalReport ? <>
            <div className={styles.projectBanner}><Style3Icon name="Reports" /><div><strong>{selectedProject ? projectLabel : projectFilter === "Unassigned" ? "Unassigned Contractors" : "All Projects"}</strong><p>{reportName} Report</p></div></div>
            <div className={styles.itemSummary} aria-label={`${reportName} summary`} aria-live="polite">
              <strong>{followupScopeBlocked ? "Project attribution unavailable" : `${loading || assessmentLoading || assessmentError ? "—" : visibleRows.length} ${finalReport === "project-compliance" ? "contractors" : finalReport === "insurance" ? "insurance items" : "follow-ups"}`}</strong>
              {finalReport === "follow-up" && !followupScopeBlocked ? <span>{followupStatuses.map(status => `${status}: ${visibleRows.filter(row => row.status === status).length}`).join(" · ")}</span> : null}
              <p>{finalReportNotes[finalReport]}</p>
            </div>
          </> : null}
          {error ? <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
          {isCompliance ? assessmentError ? <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-700">Compliance assessment unavailable: {assessmentError}</p>
            : assessmentLoading || loading ? <p role="status" className={styles.empty}>Loading authorized compliance assessments...</p>
              : <ComplianceReport key={`${projectFilter}:${search}:${statusFilter}`} companies={scopedCompanies} status={statusFilter}
                onSort={handleSort} sortKey={sortKey} sortAscending={sortAscending} />
            : followupScopeBlocked ? <div role="status" className={styles.itemSummary}><strong>Project-specific Follow-Up unavailable</strong><p>{followupScopeLimitation}</p><p>CSV/XLSX and scoped Custom Export are unavailable for this context. PDF exports this limitation notice only; it does not assert that there are no Follow-Ups.</p></div>
            : assessmentError ? <p role="alert" className={styles.empty}>Selected-project assessment unavailable: {assessmentError}</p>
            : loading || assessmentLoading ? <div className="flex min-h-48 items-center justify-center text-sm text-slate-500">Loading report data...</div> : visibleRows.length === 0 ? <div className="flex min-h-48 items-center justify-center text-sm text-slate-500">No matching report rows.</div> : (
            <div className={`${styles.tableScroll} ${itemReport || finalReport ? styles.itemTable : ""}`} role="region" aria-label="Report table" tabIndex={0}>
              <table className="w-full min-w-[780px] border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr>{currentColumns.map((column) => (
                    <th key={column.key} scope="col" aria-sort={sortKey === column.key ? sortAscending ? "ascending" : "descending" : "none"} className="border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase text-slate-500">
                      <button type="button" onClick={() => handleSort(column.key)} className="text-left hover:text-slate-900" aria-label={`Sort by ${column.label}`}>
                        {column.label}{sortKey === column.key ? (sortAscending ? " ^" : " v") : ""}
                      </button>
                    </th>
                  ))}</tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.id} style={itemReport ? {
                      backgroundColor: `rgb(${itemReportColor(row.status).fill.join(",")})`,
                      color: `rgb(${itemReportColor(row.status).text.join(",")})`,
                    } : finalReport ? {
                      backgroundColor: `rgb(${finalReportColor(row.severity ?? row.status).fill.join(",")})`,
                      color: `rgb(${finalReportColor(row.severity ?? row.status).text.join(",")})`,
                    } : undefined} className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50/70">
                      {currentColumns.map((column) => {
                        const value = row[column.key];
                        return (
                          <td key={column.key} className="max-w-[360px] px-4 py-3 text-sm text-slate-700">
                            {column.key === "companyName" ? <Link href={`/contractors/${row.contractorId}`} className="font-medium text-indigo-700 underline-offset-2 hover:underline">{row.companyName}</Link>
                              : column.key === "assignedProjects" && finalReport === "project-compliance" && selectedProject ? <span title="Project identified in the report header">Selected project</span>
                              : column.key === "status" ? <span className={itemReport ? `${styles.badge} ${styles[itemReportColor(row.status).tone]}` : finalReport ? `${styles.badge} ${styles[finalReportColor(row.severity ?? row.status).tone]}` : `inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[row.status] ?? "bg-slate-100 text-slate-700"}`}>{row.status}</span>
                                : ["expirationDate", "followupDate", "lastFollowup"].includes(column.key) ? formatDate(value as string | null) || "-"
                                  : column.key === "daysRemaining" ? row.daysRemaining ?? "-"
                                    : value || "-"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className={styles.footnote}>Report downloads preserve the selected report columns and rows. Custom exports use one row per contractor, with 38 available fields and saved templates.</p>
      </div>
      {customExport ? <DashboardExportDialog contractorIds={customExport.ids} dashboardFilter={customExport.filter} dashboardSearch={customExport.search}
        title="Reports Export" filteredScopeLabel="Current Report Results" initialScope="filtered" onClose={() => setCustomExport(null)} /> : null}
    </main>
  );
}
