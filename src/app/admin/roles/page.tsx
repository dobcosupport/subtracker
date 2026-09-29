"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { APP_MODULES, type RolePermission } from "@/types/user-management";

type RoleEntry = { role: string; is_system: boolean; created_at?: string };
type PermissionField = "can_view" | "can_add" | "can_edit" | "can_delete";

const moduleLabels: Record<(typeof APP_MODULES)[number], string> = {
  dashboard: "Dashboard",
  contractors: "Contractors",
  compliance: "Compliance",
  insurance: "Insurance",
  followups: "Follow-Ups",
  projects: "Projects",
  tiered_subs: "Tiered Subs",
  reports: "Reports",
  imports: "Imports",
  documents: "Documents",
  activity: "Activity Log",
  users: "User Management",
  roles: "Roles & Permissions",
  audit: "Audit Log",
  settings: "System Settings",
};

function emptyPermission(role: string, module: RolePermission["module"]): RolePermission {
  return { role, module, can_view: false, can_manage: false, can_add: false, can_edit: false, can_delete: false };
}

export default function RolesPermissionsPage() {
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [permissions, setPermissions] = useState<RolePermission[]>([]);
  const [selectedRole, setSelectedRole] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadRoles = async () => {
    try {
      const response = await adminFetch("/api/admin/roles");
      const result = await response.json() as { roles?: RoleEntry[]; permissions?: RolePermission[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to load permissions.");
      setRoles(result.roles ?? []);
      setPermissions(result.permissions ?? []);
      setSelectedRole((current) => current || result.roles?.[0]?.role || "");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load permissions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadRoles(); }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const currentPermissions = useMemo(() => APP_MODULES.map((module) =>
    permissions.find((permission) => permission.role === selectedRole && permission.module === module)
      ?? emptyPermission(selectedRole, module)
  ), [permissions, selectedRole]);

  const updatePermission = (module: RolePermission["module"], field: PermissionField | "all", checked: boolean) => {
    setPermissions((current) => {
      const existing = current.find((permission) => permission.role === selectedRole && permission.module === module)
        ?? emptyPermission(selectedRole, module);
      let updated: RolePermission;
      if (field === "all") {
        updated = { ...existing, can_view: checked, can_add: checked, can_edit: checked, can_delete: checked, can_manage: checked };
      } else {
        updated = { ...existing, [field]: checked };
        if (field === "can_view" && !checked) {
          updated.can_add = false;
          updated.can_edit = false;
          updated.can_delete = false;
        } else if (field !== "can_view" && checked) {
          updated.can_view = true;
        }
        updated.can_manage = updated.can_add || updated.can_edit || updated.can_delete;
      }
      return [...current.filter((permission) => permission.role !== selectedRole || permission.module !== module), updated];
    });
  };

  const cloneRole = async () => {
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({ sourceRole: selectedRole, role: cloneName }),
      });
      const result = await response.json() as { role?: RoleEntry; permissions?: RolePermission[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to clone role.");
      if (!result.role) throw new Error("The cloned role was not returned.");
      setRoles((current) => [...current, result.role!].sort((left, right) => left.role.localeCompare(right.role)));
      setPermissions((current) => [...current, ...(result.permissions ?? [])]);
      setSelectedRole(result.role.role);
      setCloneName("");
      setNotice(`Cloned ${selectedRole} to ${result.role.role}. Adjust permissions and save.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to clone role.");
    }
  };

  const savePermissions = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch("/api/admin/roles", {
        method: "PATCH",
        body: JSON.stringify({
          role: selectedRole,
          permissions: currentPermissions.map(({ module, can_view, can_add, can_edit, can_delete }) => ({ module, can_view, can_add, can_edit, can_delete })),
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to save permissions.");
      setNotice(`Permissions saved for ${selectedRole}.`);
      await loadRoles();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save permissions.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen p-7 text-slate-800">
      <div className="mx-auto max-w-7xl space-y-6">
        <header><p className="text-xs font-semibold uppercase text-slate-400">Administration</p><h1 className="mt-2 text-3xl font-semibold text-slate-900">Roles &amp; Permissions</h1></header>
        {error ? <p role="alert" className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        {notice ? <p role="status" className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}

        <section className="flex flex-wrap items-end gap-3 border-b border-slate-200 pb-4">
          <label className="min-w-64 text-sm font-medium text-slate-700">Role
            <select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value)} disabled={loading} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5">
              {roles.map((entry) => <option key={entry.role} value={entry.role}>{entry.role}{entry.is_system ? " (system)" : ""}</option>)}
            </select>
          </label>
          <label className="min-w-56 flex-1 text-sm font-medium text-slate-700">New role name
            <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} maxLength={60} placeholder="Name cloned role" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5" />
          </label>
          <button type="button" disabled={loading || !selectedRole || cloneName.trim().length < 2} onClick={() => void cloneRole()} className="rounded-md border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">Clone Role</button>
          <button type="button" disabled={loading || saving || !selectedRole || selectedRole === "Administrator"} onClick={() => void savePermissions()} className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">{saving ? "Saving..." : selectedRole === "Administrator" ? "Administrator Protected" : "Save Permissions"}</button>
        </section>

        <section className="overflow-x-auto border border-slate-200 bg-white">
          <table className="w-full min-w-[920px] border-collapse text-left">
            <thead className="bg-slate-50"><tr>
              {["Module", "All", "View", "Add", "Edit", "Delete"].map((heading) => <th key={heading} className="border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase text-slate-500">{heading}</th>)}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={6} className="p-8 text-center text-sm text-slate-500">Loading role permissions...</td></tr> : currentPermissions.map((permission) => {
                const allChecked = permission.can_view && permission.can_add && permission.can_edit && permission.can_delete;
                const controls: Array<{ field: PermissionField | "all"; checked: boolean; label: string }> = [
                  { field: "all", checked: allChecked, label: "All" },
                  { field: "can_view", checked: permission.can_view, label: "View" },
                  { field: "can_add", checked: permission.can_add, label: "Add" },
                  { field: "can_edit", checked: permission.can_edit, label: "Edit" },
                  { field: "can_delete", checked: permission.can_delete, label: "Delete" },
                ];
                return (
                  <tr key={permission.module} className="border-b border-slate-100 last:border-0">
                    <th scope="row" className="px-4 py-3 text-sm font-medium text-slate-800">{moduleLabels[permission.module]}</th>
                    {controls.map((control) => <td key={control.field} className="px-4 py-3"><input type="checkbox" aria-label={`${control.label} ${moduleLabels[permission.module]}`} checked={control.checked} disabled={selectedRole === "Administrator"} onChange={(event) => updatePermission(permission.module, control.field, event.target.checked)} className="h-4 w-4 accent-indigo-600 disabled:opacity-50" /></td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
