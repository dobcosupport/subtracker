"use client";

import { useState } from "react";
import { EXPORT_FIELDS, EXPORT_GROUPS } from "@/lib/custom-export";

interface Props {
  selected: string[];
  onChange: (fields: string[]) => void;
  disabled: boolean;
}

export default function ExportFieldSelector({ selected, onChange, disabled }: Props) {
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const visible = EXPORT_FIELDS.filter((field) => field.label.toLowerCase().includes(term));
  return (
    <section aria-labelledby="export-fields-heading" className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="export-fields-heading" className="text-sm font-semibold text-slate-900">Fields <span className="font-normal text-slate-500">({selected.length} selected)</span></h3>
        <div className="flex gap-3 text-sm">
          <button type="button" disabled={disabled} onClick={() => onChange(EXPORT_FIELDS.map((field) => field.id))} className="text-indigo-600 disabled:opacity-50">Select All</button>
          <button type="button" disabled={disabled} onClick={() => onChange([])} className="text-slate-600 disabled:opacity-50">Clear All</button>
        </div>
      </div>
      <label htmlFor="export-field-search" className="sr-only">Search fields by label</label>
      <input id="export-field-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search fields by label" className="mb-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {EXPORT_GROUPS.map((group) => {
          const fields = visible.filter((field) => field.group === group.id);
          if (fields.length === 0) return null;
          return (
            <details key={`${group.id}-${Boolean(term)}`} open className="rounded-xl border border-slate-200">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">{group.label}</summary>
              <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">
                {fields.map((field) => (
                  <label key={field.id} className="flex items-start gap-2 text-sm text-slate-600">
                    <input type="checkbox" checked={selected.includes(field.id)} disabled={disabled} onChange={(event) => onChange(event.target.checked ? [...selected, field.id] : selected.filter((id) => id !== field.id))} className="mt-0.5 accent-indigo-600" />
                    {field.label}
                  </label>
                ))}
              </div>
            </details>
          );
        })}
        {visible.length === 0 ? <p className="py-4 text-center text-sm text-slate-500">No fields match your search.</p> : null}
      </div>
    </section>
  );
}
