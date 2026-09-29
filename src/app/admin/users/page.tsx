"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { AdminUser, AuthenticationSource, UserRole, UserStatus } from "@/types/user-management";

type UserForm = {
  name: string;
  email: string;
  role: UserRole;
  entra_object_id: string;
  entra_group_name: string;
  authentication_source: AuthenticationSource;
};
const emptyForm: UserForm = {
  name: "",
  email: "",
  role: "Read Only",
  entra_object_id: "",
  entra_group_name: "",
  authentication_source: "Local",
};

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function UserManagementPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [reinviteUser, setReinviteUser] = useState<AdminUser | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadUsers = async () => {
    try {
      const response = await adminFetch("/api/admin/users");
      const result = await response.json() as { users?: AdminUser[]; roles?: string[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to load users.");
      setUsers(result.users ?? []);
      setRoles(result.roles ?? []);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load users.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadUsers(); }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users
      .filter((user) => !term || [user.name, user.email, user.role, user.display_status, user.entra_object_id ?? "", user.entra_group_name ?? "", user.authentication_source].some((value) => value.toLowerCase().includes(term)))
      .sort((left, right) => Number(right.system_administrator) - Number(left.system_administrator));
  }, [search, users]);

  const openAdd = () => {
    setEditingUser(null);
    setForm({ ...emptyForm, role: roles.includes("Read Only") ? "Read Only" : roles[0] ?? "" });
    setModalOpen(true);
    setError(null);
  };

  const openEdit = (user: AdminUser) => {
    setEditingUser(user);
    setForm({
      name: user.name,
      email: user.email,
      role: user.role,
      entra_object_id: user.entra_object_id ?? "",
      entra_group_name: user.entra_group_name ?? "",
      authentication_source: user.authentication_source,
    });
    setModalOpen(true);
    setError(null);
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch(editingUser ? `/api/admin/users/${editingUser.auth_user_id}` : "/api/admin/users", {
        method: editingUser ? "PATCH" : "POST",
        body: JSON.stringify({ ...form, status: editingUser?.status ?? "Active" }),
      });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to save user.");
      setModalOpen(false);
      setNotice(editingUser ? "User updated." : result.message ?? "Invitation sent.");
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save user.");
    } finally {
      setBusy(false);
    }
  };

  const updateStatus = async (user: AdminUser, status: UserStatus) => {
    setBusyUserId(user.auth_user_id);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch(`/api/admin/users/${user.auth_user_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: user.name,
          email: user.email,
          role: user.role,
          status,
          entra_object_id: user.entra_object_id,
          entra_group_name: user.entra_group_name,
          authentication_source: user.authentication_source,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to update user status.");
      setNotice(status === "Active" ? "User reactivated." : "User deactivated.");
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update user status.");
    } finally {
      setBusyUserId(null);
    }
  };

  const resetPassword = async (user: AdminUser) => {
    setBusyUserId(user.auth_user_id);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch(`/api/admin/users/${user.auth_user_id}/reset-password`, { method: "POST" });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to send password reset.");
      setNotice(result.message ?? "Password reset email sent.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send password reset.");
    } finally {
      setBusyUserId(null);
    }
  };

  const reinvite = async () => {
    if (!reinviteUser) return;
    const target = reinviteUser;
    setBusyUserId(target.auth_user_id);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch(`/api/admin/users/${target.auth_user_id}/re-invite`, { method: "POST" });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to send invitation.");
      setNotice(result.message ?? `Invitation sent to ${target.email}.`);
      setReinviteUser(null);
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send invitation.");
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <main className="min-h-screen p-7 text-slate-800">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase text-slate-400">Administration</p><h1 className="mt-2 text-3xl font-semibold text-slate-900">User Management</h1></div>
          <button type="button" onClick={openAdd} className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700">Add User</button>
        </header>
        {notice ? <p role="status" className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}
        {error ? <p role="alert" className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        <section className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
            <p className="text-sm font-medium text-slate-600">{filteredUsers.length} users</p>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search users" aria-label="Search users" className="w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1450px] text-left">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                {["Name", "Email", "Role", "Status", "Last Invitation Sent", "Invitation Count", "Last Login", "Created Date", "Actions"].map((heading) => <th key={heading} className="border-b border-slate-200 px-4 py-3 font-semibold">{heading}</th>)}
              </tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={9} className="p-8 text-center text-sm text-slate-500">Loading users...</td></tr> : filteredUsers.length === 0 ? <tr><td colSpan={9} className="p-8 text-center text-sm text-slate-500">No users found.</td></tr> : filteredUsers.map((user) => (
                  <tr key={user.auth_user_id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{user.name}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{user.email}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{user.role}</td>
                    <td className="px-4 py-3 text-sm"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${user.display_status === "Active" ? "bg-emerald-100 text-emerald-700" : user.display_status === "Pending Invitation" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{user.display_status}</span></td>
                    <td className="px-4 py-3 text-sm text-slate-600">{formatDate(user.last_invitation_sent)}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{user.invitation_count}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{formatDate(user.last_login)}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{formatDate(user.created_at)}</td>
                    <td className="px-4 py-3"><div className="flex items-center gap-2 text-xs">
                      <button type="button" onClick={() => openEdit(user)} className="font-medium text-indigo-700 hover:underline">Edit User</button>
                      {user.can_reinvite ? <button type="button" disabled={busyUserId === user.auth_user_id} onClick={() => setReinviteUser(user)} className="font-medium text-emerald-700 hover:underline disabled:opacity-50">Re-Invite</button> : null}
                      {user.system_administrator || user.protected_user
                        ? <span className="font-medium text-emerald-700" title="Protected system administrator">Protected</span>
                        : <button type="button" disabled={busyUserId === user.auth_user_id} onClick={() => void updateStatus(user, user.status === "Active" ? "Disabled" : "Active")} className="font-medium text-slate-600 hover:underline disabled:opacity-50">{user.status === "Active" ? "Deactivate User" : "Reactivate User"}</button>}
                      <button type="button" disabled={busyUserId === user.auth_user_id} onClick={() => void resetPassword(user)} className="font-medium text-slate-600 hover:underline disabled:opacity-50">Reset Password</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8">
          <form onSubmit={handleSave} className="max-h-full w-full max-w-lg space-y-4 overflow-y-auto border border-slate-200 bg-white p-6 shadow-xl">
            <div><p className="text-xs font-semibold uppercase text-slate-400">Administration</p><h2 className="mt-1 text-xl font-semibold text-slate-900">{editingUser ? "Edit User" : "Add User"}</h2></div>
            <label className="block text-sm font-medium text-slate-700">Name<input required minLength={2} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
            <label className="block text-sm font-medium text-slate-700">Email<input type="email" required value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
            <label className="block text-sm font-medium text-slate-700">Role<select required value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal">{roles.map((role) => <option key={role}>{role}</option>)}</select></label>
            <label className="block text-sm font-medium text-slate-700">Entra Object ID<input value={form.entra_object_id} onChange={(event) => setForm((current) => ({ ...current, entra_object_id: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
            <label className="block text-sm font-medium text-slate-700">Entra Group Name<input value={form.entra_group_name} onChange={(event) => setForm((current) => ({ ...current, entra_group_name: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" /></label>
            <label className="block text-sm font-medium text-slate-700">Authentication Source<select value={form.authentication_source} onChange={(event) => setForm((current) => ({ ...current, authentication_source: event.target.value as AuthenticationSource }))} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal"><option>Local</option><option>Microsoft Entra ID</option></select></label>
            <p className="text-xs text-slate-500">Authentication source is stored as metadata. Microsoft Entra sign-in is not enabled.</p>
            {!editingUser ? <p className="text-xs text-slate-500">An invitation email will be sent to set up account access.</p> : null}
            {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setModalOpen(false)} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700">Cancel</button><button type="submit" disabled={busy || roles.length === 0} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Saving..." : editingUser ? "Save Changes" : "Send Invitation"}</button></div>
          </form>
        </div>
      ) : null}
      {reinviteUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8">
          <section role="dialog" aria-modal="true" aria-labelledby="reinvite-title" className="w-full max-w-md space-y-5 border border-slate-200 bg-white p-6 shadow-xl">
            <h2 id="reinvite-title" className="text-xl font-semibold text-slate-900">Re-Invite User</h2>
            <div>
              <p className="text-sm text-slate-600">Send a new invitation email to:</p>
              <p className="mt-1 break-all text-sm font-medium text-slate-900">{reinviteUser.email}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReinviteUser(null)} disabled={busyUserId === reinviteUser.auth_user_id} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50">Cancel</button>
              <button type="button" onClick={() => void reinvite()} disabled={busyUserId === reinviteUser.auth_user_id} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busyUserId === reinviteUser.auth_user_id ? "Sending..." : "Send"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
