"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildPreview,
  fetchImportHistory,
  fetchReferenceData,
  generateErrorWorkbook,
  parseWorkbookFile,
  recordImportHistory,
  runImport,
  SUPPORTED_SHEETS,
  type ImportHistoryEntry,
} from "@/services/imports";
import {
  fetchContractorMasterExport,
  generateContractorMasterExportCsv,
  generateContractorMasterExportXlsx,
  type ContractorExportFilter,
} from "@/services/exports";
import type { ImportAction, ImportPreviewResult, ImportRunResult, ImportSheetName } from "@/types/imports";
import ExportTemplateManager from "@/components/exports/ExportTemplateManager";

const actionStyles: Record<ImportAction, string> = {
  Create: "bg-emerald-100 text-emerald-700",
  Update: "bg-sky-100 text-sky-700",
  Skip: "bg-slate-200 text-slate-600",
  Error: "bg-red-100 text-red-700",
};

const actionFilters: (ImportAction | "All")[] = ["All", "Create", "Update", "Skip", "Error"];

const importTemplates = [
  { name: "Contractor Import Template", description: "Contractor master data, contacts, registration numbers, and BRC Name Control." },
  { name: "Project Import Template", description: "Projects, project assignments, and tiered sub relationships." },
  { name: "Compliance Import Template", description: "Compliance records, registration numbers, and expiration dates." },
  { name: "Insurance Import Template", description: "Insurance certificates, general liability, and workers' comp tracking." },
];

const exportFilters: { value: ContractorExportFilter; label: string }[] = [
  { value: "all", label: "All Contractors" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export default function ImportsPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [activeSheet, setActiveSheet] = useState<ImportSheetName>("Projects");
  const [actionFilter, setActionFilter] = useState<ImportAction | "All">("All");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportSheetName | null>(null);
  const [importResult, setImportResult] = useState<ImportRunResult | null>(null);
  const [exportFilter, setExportFilter] = useState<ContractorExportFilter>("all");
  const [exporting, setExporting] = useState<"xlsx" | "csv" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = async () => {
    const { data, error } = await fetchImportHistory();
    if (error) {
      setHistoryError(error.message);
      setHistory([]);
      return;
    }
    setHistoryError(null);
    setHistory(data ?? []);
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  const processFile = async (file: File) => {
    setLoading(true);
    setLoadError(null);
    setPreview(null);
    setImportResult(null);
    setActionFilter("All");
    try {
      const sheets = await parseWorkbookFile(file);
      const reference = await fetchReferenceData();
      const result = buildPreview(file.name, sheets, reference);
      setPreview(result);
      setActiveSheet(SUPPORTED_SHEETS.find((sheet) => (result.rowsBySheet[sheet]?.length ?? 0) > 0) ?? "Projects");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to read the workbook.");
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelected = (file: File | null) => {
    if (!file) return;
    const isValidExtension = /\.(xlsx|xls)$/i.test(file.name);
    if (!isValidExtension) {
      setLoadError("Only .xlsx and .xls files are supported.");
      return;
    }
    setSelectedFile(file);
    void processFile(file);
  };

  const handleClearFile = () => {
    setSelectedFile(null);
    setPreview(null);
    setLoadError(null);
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    handleFileSelected(file);
  };

  const currentRows = useMemo(() => {
    if (!preview) return [];
    const rows = preview.rowsBySheet[activeSheet] ?? [];
    const filtered = actionFilter === "All" ? rows : rows.filter((row) => row.action === actionFilter);
    return filtered.slice(0, 100);
  }, [preview, activeSheet, actionFilter]);

  const totals = useMemo(() => {
    if (!preview) return { create: 0, update: 0, skip: 0, error: 0 };
    return preview.summaries.reduce(
      (acc, summary) => ({
        create: acc.create + summary.newRecords,
        update: acc.update + summary.updateRecords,
        skip: acc.skip + summary.skippedRows,
        error: acc.error + summary.errorRows,
      }),
      { create: 0, update: 0, skip: 0, error: 0 }
    );
  }, [preview]);

  const allErrors = useMemo(() => {
    if (!preview) return [];
    return SUPPORTED_SHEETS.flatMap((sheet) => (preview.rowsBySheet[sheet] ?? []).flatMap((row) => row.errors));
  }, [preview]);

  const handleImport = async () => {
    if (!preview || !selectedFile) return;
    setImporting(true);
    setConfirmOpen(false);
    const result = await runImport(preview, (worksheet) => setImportProgress(worksheet));
    await recordImportHistory(selectedFile.name, preview, result);
    setImportResult(result);
    setImportProgress(null);
    setImporting(false);
    void loadHistory();
  };

  const handleContractorExport = async (format: "xlsx" | "csv") => {
    setExporting(format);
    setExportError(null);
    try {
      const { rows, error } = await fetchContractorMasterExport(exportFilter);
      if (error) {
        setExportError(error.message);
        return;
      }
      const blob = format === "xlsx" ? generateContractorMasterExportXlsx(rows) : generateContractorMasterExportCsv(rows);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `SubTracker_Contractor_Master_Export_${new Date().toISOString().slice(0, 10)}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(null);
    }
  };

  const handleDownloadErrorReport = () => {
    const blob = generateErrorWorkbook(allErrors);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "SubTracker_Import_Errors.xlsx";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Import / Export</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">Bulk data movement for SubTracker — download templates, import validated workbooks, and export contractor master data for backups, migrations, and integrations.</p>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Import Templates</h2>
          <p className="mt-1 text-sm text-slate-500">Each template is provided as a worksheet inside the SubTracker master template workbook.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {importTemplates.map((template) => (
              <div key={template.name} className="flex flex-col rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-800">{template.name}</p>
                <p className="mt-1 flex-1 text-xs leading-5 text-slate-500">{template.description}</p>
                <a href="/SubTracker_Import_Template.xlsx" download className="mt-3 inline-flex w-fit rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">Download</a>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-900">Imports</h2>
          <div
            onDragOver={(event) => { event.preventDefault(); setIsDragActive(true); }}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition ${isDragActive ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-slate-50"}`}
          >
            <p className="text-sm font-medium text-slate-700">Drag and drop your Excel workbook here</p>
            <p className="text-xs text-slate-500">Accepted formats: .xlsx, .xls</p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800">Choose Excel File</button>
              <a href="/SubTracker_Import_Template.xlsx" download className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">Download Import Template</a>
              {selectedFile ? <button type="button" onClick={handleClearFile} className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50">Clear File</button> : null}
            </div>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(event) => handleFileSelected(event.target.files?.[0] ?? null)} />
            {selectedFile ? <p className="mt-2 text-xs text-slate-500">Selected file: {selectedFile.name}</p> : null}
          </div>
          {loading ? <p className="mt-4 text-sm text-slate-500">Reading workbook...</p> : null}
          {loadError ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p> : null}
        </section>

        {preview ? (
          <>
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-900">File Preview</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-semibold uppercase text-slate-400">File Name</p><p className="mt-1 text-sm font-medium text-slate-700">{preview.fileName}</p></div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase text-emerald-700">New Records</p><p className="mt-1 text-2xl font-semibold text-emerald-700">{totals.create}</p></div>
                <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><p className="text-xs font-semibold uppercase text-sky-700">Existing Records to Update</p><p className="mt-1 text-2xl font-semibold text-sky-700">{totals.update}</p></div>
                <div className="rounded-xl border border-red-200 bg-red-50 p-4"><p className="text-xs font-semibold uppercase text-red-700">Error Rows</p><p className="mt-1 text-2xl font-semibold text-red-700">{totals.error}</p></div>
              </div>

              <div className="mt-6 overflow-x-auto">
                <table className="min-w-[900px] border-collapse text-left">
                  <thead className="bg-slate-50">
                    <tr>{["Worksheet", "Total Rows", "Valid Rows", "New Records", "Existing Records to Update", "Skipped Rows", "Error Rows"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.summaries.map((summary) => (
                      <tr key={summary.worksheet}>
                        <td className="border border-slate-200 px-4 py-3 text-sm font-medium">{summary.worksheet}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm">{summary.totalRows}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm">{summary.validRows}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm">{summary.newRecords}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm">{summary.updateRecords}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm">{summary.skippedRows}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm">{summary.errorRows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-5 py-4">
                {SUPPORTED_SHEETS.map((sheet) => (
                  <button
                    key={sheet}
                    type="button"
                    onClick={() => setActiveSheet(sheet)}
                    className={`rounded-lg px-3 py-2 text-sm font-medium ${activeSheet === sheet ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  >
                    {sheet} ({preview.rowsBySheet[sheet]?.length ?? 0})
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-5 py-3">
                <span className="text-xs font-semibold uppercase text-slate-400">Filter by Action</span>
                {actionFilters.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setActionFilter(filter)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${actionFilter === filter ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-[900px] border-collapse text-left">
                  <thead className="bg-slate-50">
                    <tr>{["Row", "Identifier", "Action", "Details"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
                  </thead>
                  <tbody>
                    {currentRows.map((row) => (
                      <tr key={`${row.worksheet}-${row.rowNumber}`}>
                        <td className="border border-slate-200 px-4 py-3 text-sm">{row.rowNumber}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm font-medium">{row.identifier}</td>
                        <td className="border border-slate-200 px-4 py-3 text-sm"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${actionStyles[row.action]}`}>{row.action}</span></td>
                        <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                          {row.errors.length > 0 ? row.errors.map((error) => `${error.field}: ${error.message}`).join("; ") : JSON.stringify(row.data)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {currentRows.length === 0 ? <p className="p-5 text-sm text-slate-500">No rows match the selected filter.</p> : null}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">Import</h2>
                  <p className="mt-1 text-sm text-slate-500">Only valid rows (Create/Update/Skip) will be processed. Error rows are excluded.</p>
                </div>
                <div className="flex flex-wrap gap-3">
                  {allErrors.length > 0 ? <button type="button" onClick={handleDownloadErrorReport} className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50">Download Error Report</button> : null}
                  <button type="button" disabled={importing} onClick={() => setConfirmOpen(true)} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                    {importing ? `Importing ${importProgress ?? "..."}` : "Import Valid Rows"}
                  </button>
                </div>
              </div>

              {importResult ? (
                <div className="mt-6 grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-semibold uppercase text-slate-400">Total Processed</p><p className="mt-1 text-xl font-semibold text-slate-800">{importResult.totalProcessed}</p></div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase text-emerald-700">Successful</p><p className="mt-1 text-xl font-semibold text-emerald-700">{importResult.successful}</p></div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase text-emerald-700">Created</p><p className="mt-1 text-xl font-semibold text-emerald-700">{importResult.created}</p></div>
                  <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><p className="text-xs font-semibold uppercase text-sky-700">Updated</p><p className="mt-1 text-xl font-semibold text-sky-700">{importResult.updated}</p></div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-semibold uppercase text-slate-500">Skipped</p><p className="mt-1 text-xl font-semibold text-slate-700">{importResult.skipped}</p></div>
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4"><p className="text-xs font-semibold uppercase text-red-700">Failed</p><p className="mt-1 text-xl font-semibold text-red-700">{importResult.failed}</p></div>
                </div>
              ) : null}
            </section>
          </>
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Exports</h2>
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-800">Contractor Master Export</p>
                <p className="mt-1 max-w-xl text-sm leading-6 text-slate-500">Export all contractor master data for backup, migration, and future integrations. Includes company and contact information, NJ/NY PWC and BRC numbers, BRC Name Control, Sage ERP ID, active status, project assignments, compliance summary, insurance summary, and created/updated dates.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {exportFilters.map((filter) => (
                  <button key={filter.value} type="button" onClick={() => setExportFilter(filter.value)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${exportFilter === filter.value ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"}`}>
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" disabled={exporting !== null} onClick={() => void handleContractorExport("xlsx")} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                {exporting === "xlsx" ? "Preparing..." : "Export Excel (.xlsx)"}
              </button>
              <button type="button" disabled={exporting !== null} onClick={() => void handleContractorExport("csv")} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60">
                {exporting === "csv" ? "Preparing..." : "Export CSV"}
              </button>
            </div>
            {exportError ? <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{exportError}</p> : null}
          </div>
          <p className="mt-3 text-xs text-slate-400">Future exports (projects, compliance, insurance) can be added to this section.</p>
        </section>

        <ExportTemplateManager />

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">History</h2></div>
          {historyError ? <p className="p-5 text-sm text-red-600">{historyError}</p> : history.length === 0 ? <p className="p-5 text-sm text-slate-500">No imports have been recorded yet.</p> : (
            <div className="overflow-x-auto">
              <table className="min-w-[800px] border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr>{["File Name", "Import Date", "Total Rows", "Successful", "Failed", "Notes"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id}>
                      <td className="border border-slate-200 px-4 py-3 text-sm font-medium">{entry.file_name}</td>
                      <td className="border border-slate-200 px-4 py-3 text-sm">{new Date(entry.import_date).toLocaleString()}</td>
                      <td className="border border-slate-200 px-4 py-3 text-sm">{entry.imported_rows}</td>
                      <td className="border border-slate-200 px-4 py-3 text-sm">{entry.successful_rows}</td>
                      <td className="border border-slate-200 px-4 py-3 text-sm">{entry.failed_rows}</td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{entry.notes || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900">Confirm Import</h2>
            <div className="mt-4 space-y-2 text-sm text-slate-700">
              <p>Records to Create: <span className="font-semibold">{totals.create}</span></p>
              <p>Records to Update: <span className="font-semibold">{totals.update}</span></p>
              <p>Records to Skip: <span className="font-semibold">{totals.skip}</span></p>
              <p>Records with Errors (excluded): <span className="font-semibold">{totals.error}</span></p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700">Cancel</button>
              <button type="button" onClick={() => void handleImport()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white">Confirm Import</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
