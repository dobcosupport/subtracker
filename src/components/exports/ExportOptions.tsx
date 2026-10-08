"use client";

import { EXPORT_FIELDS } from "@/lib/custom-export";
import { EXPORT_SORT_FIELDS } from "@/lib/export-template-config";
import type { CustomExportConfiguration, ExportFilters } from "@/types/custom-export";

export default function ExportOptions({ configuration, onChange, disabled = false }: {
  configuration: CustomExportConfiguration;
  onChange: (configuration: CustomExportConfiguration) => void;
  disabled?: boolean;
}) {
  const filters = configuration.filters ?? {};
  const setFilter = <K extends keyof ExportFilters>(key: K, value: ExportFilters[K] | undefined) => {
    const next = { ...filters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...configuration, filters: Object.keys(next).length ? next : null });
  };
  return <fieldset disabled={disabled} className="grid gap-3 text-sm sm:grid-cols-2">
    <legend className="mb-2 font-semibold">Sort and additional filters</legend>
    <label>Sort by<select value={configuration.sort?.field ?? "contractor_name"} onChange={(event) => {
      const field = EXPORT_SORT_FIELDS.find((item) => item === event.target.value);
      if (field) onChange({ ...configuration, sort: { field, direction: configuration.sort?.direction ?? "asc" } });
    }} className="mt-1 block w-full rounded-lg border p-2">{EXPORT_SORT_FIELDS.map((field) => <option key={field} value={field}>{EXPORT_FIELDS.find((item) => item.id === field)?.label}</option>)}</select></label>
    <label>Direction<select value={configuration.sort?.direction ?? "asc"} onChange={(event) => onChange({ ...configuration, sort: { field: configuration.sort?.field ?? "contractor_name", direction: event.target.value === "desc" ? "desc" : "asc" } })} className="mt-1 block w-full rounded-lg border p-2"><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    <label>Contractor status<select value={filters.contractor_status ?? ""} onChange={(event) => setFilter("contractor_status", event.target.value === "Active" ? "Active" : event.target.value === "Inactive" ? "Inactive" : undefined)} className="mt-1 block w-full rounded-lg border p-2"><option value="">Any status</option><option>Active</option><option>Inactive</option></select></label>
    <label>Material vendor<select value={filters.material_vendor_only === undefined ? "" : String(filters.material_vendor_only)} onChange={(event) => setFilter("material_vendor_only", event.target.value === "" ? undefined : event.target.value === "true")} className="mt-1 block w-full rounded-lg border p-2"><option value="">Any</option><option value="true">Yes</option><option value="false">No</option></select></label>
    {(["state", "city", "contractor_name"] as const).map((field) => <label key={field}>{field === "state" ? "State equals" : field === "city" ? "City contains" : "Contractor name contains"}<input value={filters[field] ?? ""} maxLength={200} onChange={(event) => setFilter(field, event.target.value || undefined)} className="mt-1 block w-full rounded-lg border p-2" /></label>)}
    <p className="text-xs text-slate-500 sm:col-span-2">Filters are combined with AND and narrow the chosen scope only. They do not change the Dashboard.</p>
  </fieldset>;
}
