"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { getContractors } from "@/services/contractors";
import {
  getCompanyComplianceStatus,
  getDashboardData,
  type CompanyComplianceStatus,
  type DashboardRecord,
} from "@/services/dashboard";
import { getFollowups } from "@/services/followups";
import type { ComplianceStatus, ContractorFollowup } from "@/types/database";

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
  "missing-information": [
    { key: "companyName", label: "Company Name" },
    { key: "item", label: "Missing Item" },
    { key: "status", label: "Status" },
    { key: "assignedProjects", label: "Assigned Projects" },
  ],
  "expired-items": [
    { key: "companyName", label: "Company Name" },
    { key: "item", label: "Expired Item" },
    { key: "expirationDate", label: "Expiration Date" },
    { key: "daysRemaining", label: "Days Remaining" },
    { key: "assignedProjects", label: "Assigned Projects" },
  ],
  "upcoming-expirations": [
    { key: "companyName", label: "Company Name" },
    { key: "item", label: "Expiring Item" },
    { key: "expirationDate", label: "Expiration Date" },
    { key: "daysRemaining", label: "Days Remaining" },
    { key: "status", label: "Status" },
    { key: "assignedProjects", label: "Assigned Projects" },
  ],
  "project-compliance": [
    { key: "companyName", label: "Contractor" },
    { key: "status", label: "Status" },
    { key: "assignedProjects", label: "Assigned Projects" },
    { key: "complianceIssues", label: "Compliance Issues" },
    { key: "insuranceIssues", label: "Insurance Issues" },
  ],
  insurance: [
    { key: "companyName", label: "Company Name" },
    { key: "item", label: "Insurance Item" },
    { key: "status", label: "Status" },
    { key: "expirationDate", label: "Expiration Date" },
    { key: "daysRemaining", label: "Days Remaining" },
    { key: "assignedProjects", label: "Assigned Projects" },
  ],
  "follow-up": [
    { key: "companyName", label: "Company Name" },
    { key: "status", label: "Status" },
    { key: "followupDate", label: "Follow-Up Date" },
    { key: "lastFollowup", label: "Last Follow-Up" },
    { key: "method", label: "Method" },
    { key: "subject", label: "Subject" },
    { key: "notes", label: "Notes" },
  ],
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
  const [activeContractorCount, setActiveContractorCount] = useState(0);
  const [selectedReport, setSelectedReport] = useState<ReportType>("compliance-status");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All statuses");
  const [projectFilter, setProjectFilter] = useState("All projects");
  const [sortKey, setSortKey] = useState<ReportColumnKey>("companyName");
  const [sortAscending, setSortAscending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadReports = async () => {
      const [dashboardResult, contractorResult, followupResult] = await Promise.all([
        getDashboardData(),
        getContractors(),
        getFollowups(),
      ]);
      const loadError = dashboardResult.error || contractorResult.error || followupResult.error;
      if (loadError) {
        setError(loadError.message || "Unable to load report data.");
        setLoading(false);
        return;
      }

      const contractorsById = new Map((contractorResult.data ?? []).map((contractor) => [contractor.id, contractor.company_name]));
      setRecords(dashboardResult.data?.records ?? []);
      setProjectsByContractor(dashboardResult.data?.projectNumbersByContractor ?? new Map());
      setActiveContractorCount(dashboardResult.data?.activeContractorCount ?? 0);
      setFollowups((followupResult.data ?? []).map((followup) => ({
        ...followup,
        companyName: contractorsById.get(followup.contractor_id) ?? "Unknown contractor",
      })));
      setError(null);
      setLoading(false);
    };

    void loadReports();
  }, []);

  const reportRows = useMemo(() => {
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
      status: record.calculated_status,
      expirationDate: record.expiration_date,
      daysRemaining: record.days_remaining,
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
    if (selectedReport === "upcoming-expirations") return itemRows.filter((row) => ["30 Day", "60 Day", "90 Day"].includes(row.status));
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
  }, [followups, records, projectsByContractor, selectedReport]);

  const currentColumns = columnsByReport[selectedReport];
  const statusOptions = useMemo(() => selectedReport === "follow-up"
    ? [...followupStatuses]
    : [...new Set(reportRows.map((row) => row.status))].sort(), [reportRows, selectedReport]);
  const projectOptions = useMemo(() => [...new Set([...projectsByContractor.values()].flat())].sort(), [projectsByContractor]);
  const followupCounts = useMemo(() => followupStatuses.map((status) => ({
    status,
    count: followups.filter((followup) => followup.status === status).length,
  })), [followups]);
  const latestFollowupDate = followups.reduce<string | null>((latest, followup) =>
    !latest || followup.followup_date > latest ? followup.followup_date : latest, null);

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return reportRows
      .filter((row) => statusFilter === "All statuses" || row.status === statusFilter)
      .filter((row) => projectFilter === "All projects"
        || (projectFilter === "Unassigned" ? !row.assignedProjects : row.assignedProjects.split(", ").includes(projectFilter)))
      .filter((row) => !term || currentColumns.some((column) => String(row[column.key] ?? "").toLowerCase().includes(term)))
      .sort((left, right) => {
        const leftValue = left[sortKey];
        const rightValue = right[sortKey];
        const comparison = typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue ?? "").localeCompare(String(rightValue ?? ""), undefined, { numeric: true, sensitivity: "base" });
        return sortAscending ? comparison : -comparison;
      });
  }, [currentColumns, projectFilter, reportRows, search, sortAscending, sortKey, statusFilter]);

  const handleSort = (key: ReportColumnKey) => {
    if (sortKey === key) setSortAscending((ascending) => !ascending);
    else {
      setSortKey(key);
      setSortAscending(true);
    }
  };

  const handleExport = (format: "xlsx" | "csv") => {
    const worksheet = XLSX.utils.json_to_sheet(toExportRows(visibleRows, currentColumns));
    const reportName = reports.find((report) => report.id === selectedReport)?.label ?? "Report";
    const filename = `SubTracker_${reportName.replace(/[^a-z0-9]+/gi, "_")}`;
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
    <main className="min-h-screen p-7 text-slate-800">
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-900">Reports</h1>
            <p className="mt-1 text-sm text-slate-500">{activeContractorCount} active contractors in the current dashboard dataset</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => handleExport("xlsx")} disabled={loading || visibleRows.length === 0} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">Export Excel</button>
            <button type="button" onClick={() => handleExport("csv")} disabled={loading || visibleRows.length === 0} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">Export CSV</button>
          </div>
        </header>

        <section className="border-b border-slate-200">
          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Reports">
            {reports.map((report) => (
              <button key={report.id} type="button" role="tab" aria-selected={selectedReport === report.id} onClick={() => { setSelectedReport(report.id); setStatusFilter("All statuses"); }} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium ${selectedReport === report.id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
                {report.label}
              </button>
            ))}
          </div>
        </section>

        {selectedReport === "follow-up" ? (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Follow-up status summary">
            {followupCounts.map(({ status, count }) => (
              <div key={status} className="rounded-lg border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase text-slate-500">{status}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{count}</p>
              </div>
            ))}
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold uppercase text-slate-500">Last Follow-Up</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">{formatDate(latestFollowupDate) || "-"}</p>
            </div>
          </section>
        ) : null}

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search report" aria-label="Search report" className="min-w-56 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by status" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
              <option>All statuses</option>
              {statusOptions.map((status) => <option key={status}>{status}</option>)}
            </select>
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="Filter by project" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
              <option>All projects</option>
              <option>Unassigned</option>
              {projectOptions.map((project) => <option key={project}>{project}</option>)}
            </select>
            <span className="text-sm text-slate-500">{visibleRows.length} rows</span>
          </div>

          {error ? <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
          {loading ? <div className="flex min-h-48 items-center justify-center text-sm text-slate-500">Loading report data...</div> : visibleRows.length === 0 ? <div className="flex min-h-48 items-center justify-center text-sm text-slate-500">No matching report rows.</div> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr>{currentColumns.map((column) => (
                    <th key={column.key} scope="col" className="border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase text-slate-500">
                      <button type="button" onClick={() => handleSort(column.key)} className="text-left hover:text-slate-900" aria-label={`Sort by ${column.label}`}>
                        {column.label}{sortKey === column.key ? (sortAscending ? " ^" : " v") : ""}
                      </button>
                    </th>
                  ))}</tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50/70">
                      {currentColumns.map((column) => {
                        const value = row[column.key];
                        return (
                          <td key={column.key} className="max-w-[360px] px-4 py-3 text-sm text-slate-700">
                            {column.key === "companyName" ? <Link href={`/contractors/${row.contractorId}`} className="font-medium text-indigo-700 underline-offset-2 hover:underline">{row.companyName}</Link>
                              : column.key === "status" ? <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[row.status] ?? "bg-slate-100 text-slate-700"}`}>{row.status}</span>
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
      </div>
    </main>
  );
}
