"use client";

import { useState, type ReactNode } from "react";
import { TEMPLATE_CATEGORIES, type ExportTemplate, type TemplatePreference } from "@/types/export-template";

export default function ExportTemplateList({ templates, preferences, actions, preference, disabled, management = false }: {
  templates: ExportTemplate[];
  preferences: TemplatePreference[];
  actions: (template: ExportTemplate) => ReactNode;
  preference: (id: string, favorite: boolean, isDefault: boolean) => void;
  disabled: boolean;
  management?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [visibility, setVisibility] = useState("");
  const [active, setActive] = useState("active");
  const selected = templates.filter((template) => (!category || template.category === category)
    && (!visibility || template.visibility === visibility)
    && (management && active === "all" || template.active === (active !== "inactive"))
    && `${template.name} ${template.description ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const unknown = selected.filter((template) => !TEMPLATE_CATEGORIES.some((item) => item.id === template.category));
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Search templates<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
      <label className="text-sm">Category<select value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1 block w-full rounded-lg border p-2"><option value="">All Categories</option>{TEMPLATE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {management ? <>
        <label className="text-sm">Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value)} className="mt-1 block w-full rounded-lg border p-2"><option value="">All visibility</option><option value="private">Private</option><option value="shared">Shared</option></select></label>
        <label className="text-sm">Active status<select value={active} onChange={(event) => setActive(event.target.value)} className="mt-1 block w-full rounded-lg border p-2"><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All statuses</option></select></label>
      </> : null}
    </div>
    {unknown.length ? <p role="alert" className="text-sm text-red-700">Unsupported template categories: {unknown.map((template) => template.name).join(", ")}. Update these templates before exporting.</p> : null}
    {TEMPLATE_CATEGORIES.map((group) => {
      const list = selected.filter((template) => template.category === group.id).sort((a, b) => {
        const priority = (template: ExportTemplate) => {
          const pref = preferences.find((item) => item.template_id === template.id);
          return pref?.is_default ? 2 : pref?.is_favorite ? 1 : 0;
        };
        return priority(b) - priority(a) || a.name.localeCompare(b.name);
      });
      if (!list.length) return null;
      return <section key={group.id} className="space-y-2">
        <h3 className="font-semibold text-slate-800">{group.label} ({list.length})</h3>
        {list.map((template) => {
          const pref = preferences.find((item) => item.template_id === template.id);
          return <article key={template.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h4 className="font-semibold">{template.name}{pref?.is_default ? " (Your default)" : ""}{pref?.is_favorite ? " (Favorite)" : ""}</h4>
            {template.description ? <p className="mt-1 text-sm text-slate-600">{template.description}</p> : null}
            <p className="mt-2 text-xs text-slate-500">{group.label} · {template.is_system ? "System" : template.visibility === "shared" ? "Shared" : "Private"} · {template.default_format.toUpperCase()} · {template.default_scope === "all" ? "All Contractors" : "Current Dashboard Results"} · {template.field_ids.length} fields · {template.active ? "Active" : "Inactive"}</p>
            {management ? <p className="mt-1 text-xs text-slate-500">Created by {template.created_by_name} · {new Date(template.created_at).toLocaleDateString()} · Updated {new Date(template.updated_at).toLocaleDateString()}</p> : null}
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              {actions(template)}
              {template.active ? <>
                <button type="button" disabled={disabled} onClick={() => preference(template.id, !pref?.is_favorite, pref?.is_default ?? false)} className="text-indigo-600 disabled:opacity-40">{pref?.is_favorite ? "Unfavorite" : "Favorite"}</button>
                <button type="button" disabled={disabled} onClick={() => preference(template.id, pref?.is_favorite ?? false, !pref?.is_default)} className="text-indigo-600 disabled:opacity-40">{pref?.is_default ? "Clear default" : "Set as default"}</button>
              </> : null}
            </div>
          </article>;
        })}
      </section>;
    })}
    {!selected.length ? <p className="text-sm text-slate-500">No accessible templates match these filters.</p> : null}
  </div>;
}
