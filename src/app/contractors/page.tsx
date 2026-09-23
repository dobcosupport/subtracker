"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createContractor, getContractors, updateContractor } from "@/services/contractors";
import type { Contractor } from "@/types/database";

/*

import { useEffect, useMemo, useState } from "react";
import { createContractor, getContractors } from "@/services/contractors";
import type { Contractor } from "@/types/database";

const emptyForm = {
  company_name: "",
  trade: "",
  contact_name: "",
  email: "",
  phone: "",
  notes: "",
};

export default function ContractorsPage() {
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<
    "company_name" | "trade" | "contact_name"
  >("company_name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchContractors = async () => {
    setLoading(true);
    setError(null);

    const { data, error: supabaseError } = await getContractors();

    if (supabaseError) {
      setError(supabaseError.message || "Unable to load contractors.");
      setContractors([]);
      setLoading(false);
      return;
    }

    setContractors(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void fetchContractors();
  }, []);

  const filteredContractors = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!term) {
      return contractors;
    }

    const matchingContractors = contractors.filter((contractor) => {
      const haystacks = [
        contractor.company_name,
        contractor.trade,
        contractor.contact_name,
      ];

      return haystacks.some((value) =>
        (value ?? "").toLowerCase().includes(term)
      );
    });

    return [...matchingContractors].sort((left, right) => {
      const leftValue = left[sortColumn] ?? "";
      const rightValue = right[sortColumn] ?? "";
      const comparison = leftValue.localeCompare(rightValue, undefined, {
        sensitivity: "base",
      });

      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [contractors, search, sortColumn, sortDirection]);

  const handleSort = (
    column: "company_name" | "trade" | "contact_name"
  ) => {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortColumn(column);
    setSortDirection("asc");
  };

  const handleInputChange = (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleCreateContractor = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.company_name.trim()) {
      setFormError("Company Name is required.");
      return;
    }

    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }

    setSaving(true);
    setFormError(null);

    const payload: Omit<Contractor, "id" | "created_at" | "updated_at"> = {
      company_name: form.company_name.trim(),
      trade: form.trade.trim() || null,
      contact_name: form.contact_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      notes: form.notes.trim() || null,
      external_id: null,
      legacy_id: null,
      active: true,
    };

    const { error: createError } = await createContractor(payload);

    if (createError) {
      setFormError(createError.message || "Unable to create contractor.");
      setSaving(false);
      return;
    }

    await fetchContractors();
    setForm(emptyForm);
    setIsModalOpen(false);
    setSaving(false);
    setSuccessMessage("Contractor added successfully.");
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setForm(emptyForm);
    setFormError(null);
  };

  const sortIndicator = (column: "company_name" | "trade" | "contact_name") => {
    if (sortColumn !== column) {
      return "↕";
    }

    return sortDirection === "asc" ? "↑" : "↓";
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
              Operations
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              Contractors
            </h1>
          </div>

          <button
            type="button"
            onClick={() => {
              setSuccessMessage(null);
              setFormError(null);
              setIsModalOpen(true);
            }}
            className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Add Contractor
          </button>
        </div>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Contractor Directory</h2>
              <p className="mt-1 text-sm text-slate-500">Total Contractors: {contractors.length}</p>
            </div>

            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search contractors"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white sm:w-72"
            />
          </div>

          {successMessage ? (
            <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">
              {successMessage}
            </div>
          ) : null}

          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-medium text-slate-500">
              Loading contractors...
            </div>
          ) : error ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-red-600">
              {error}
            </div>
          ) : filteredContractors.length === 0 ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-slate-500">
              No contractors found.
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="min-w-[760px] border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      <button type="button" onClick={() => handleSort("company_name")} className="inline-flex items-center gap-2 hover:text-slate-900">
                        Company Name <span aria-hidden="true">{sortIndicator("company_name")}</span>
                      </button>
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      <button type="button" onClick={() => handleSort("trade")} className="inline-flex items-center gap-2 hover:text-slate-900">
                        Trade <span aria-hidden="true">{sortIndicator("trade")}</span>
                      </button>
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      <button type="button" onClick={() => handleSort("contact_name")} className="inline-flex items-center gap-2 hover:text-slate-900">
                        Contact Name <span aria-hidden="true">{sortIndicator("contact_name")}</span>
                      </button>
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Email
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Phone
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Active
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredContractors.map((contractor) => (
                    <tr key={contractor.id} className="bg-white hover:bg-slate-50/80">
                      <td className="border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800">
                        {contractor.company_name}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.trade || "—"}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.contact_name || "—"}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.email || "—"}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.phone || "—"}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                            contractor.active
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-slate-200 text-slate-600"
                          }`}
                        >
                          {contractor.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between gap-4">
              <h3 className="text-xl font-semibold text-slate-900">Add Contractor</h3>
              <button
                type="button"
                onClick={closeModal}
                className="text-sm font-medium text-slate-500 hover:text-slate-700"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleCreateContractor} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Company Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="company_name"
                  value={form.company_name}
                  onChange={handleInputChange}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                  required
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Trade</label>
                  <input
                    type="text"
                    name="trade"
                    value={form.trade}
                    onChange={handleInputChange}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Contact Name</label>
                  <input
                    type="text"
                    name="contact_name"
                    value={form.contact_name}
                    onChange={handleInputChange}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Email</label>
                  <input
                    type="email"
                    name="email"
                    value={form.email}
                    onChange={handleInputChange}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Phone</label>
                  <input
                    type="tel"
                    name="phone"
                    value={form.phone}
                    onChange={handleInputChange}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Notes</label>
                <textarea
                  name="notes"
                  value={form.notes}
                  onChange={handleInputChange}
                  rows={4}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                />
              </div>

              {formError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {formError}
                </div>
              ) : null}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {saving ? "Saving..." : "Save Contractor"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
} */

const emptyForm = {
  company_name: "",
  trade: "",
  contact_name: "",
  email: "",
  phone: "",
  notes: "",
  active: true,
};

export default function ContractorsPage() {
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchContractors = async () => {
    setLoading(true);
    setError(null);
    const { data, error: contractorsError } = await getContractors();

    if (contractorsError) {
      setError(contractorsError.message || "Unable to load contractors.");
      setContractors([]);
      setLoading(false);
      return;
    }

    setContractors(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void fetchContractors();
  }, []);

  const filteredContractors = useMemo(() => {
    const term = search.trim().toLowerCase();

    return contractors.filter((contractor) =>
      [contractor.company_name, contractor.trade, contractor.contact_name, contractor.email, contractor.phone].some((value) =>
        (value ?? "").toLowerCase().includes(term)
      )
    );
  }, [contractors, search]);

  const openAddModal = () => {
    setEditingContractor(null);
    setForm(emptyForm);
    setFormError(null);
    setSuccessMessage(null);
    setIsModalOpen(true);
  };

  const openEditModal = (contractor: Contractor) => {
    setEditingContractor(contractor);
    setForm({
      company_name: contractor.company_name,
      trade: contractor.trade ?? "",
      contact_name: contractor.contact_name ?? "",
      email: contractor.email ?? "",
      phone: contractor.phone ?? "",
      notes: contractor.notes ?? "",
      active: contractor.active,
    });
    setFormError(null);
    setSuccessMessage(null);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingContractor(null);
    setForm(emptyForm);
    setFormError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.company_name.trim()) {
      setFormError("Company Name is required.");
      return;
    }

    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }

    setSaving(true);
    setFormError(null);
    const fields = {
      company_name: form.company_name.trim(),
      trade: form.trade.trim() || null,
      contact_name: form.contact_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      notes: form.notes.trim() || null,
      active: form.active,
    };

    const result = editingContractor
      ? await updateContractor(editingContractor.id, fields)
      : await createContractor({ ...fields, external_id: null, legacy_id: null });

    if (result.error) {
      setFormError(result.error.message || "Unable to save contractor.");
      setSaving(false);
      return;
    }

    await fetchContractors();
    closeModal();
    setSaving(false);
    setSuccessMessage(editingContractor ? "Contractor updated successfully." : "Contractor added successfully.");
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Contractor Management</h1></div><button type="button" onClick={openAddModal} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800">Add Contractor</button></div>
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-xl font-semibold text-slate-900">Contractor Directory</h2><p className="mt-1 text-sm text-slate-500">Total Contractors: {contractors.length}</p></div><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search contractors" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm sm:w-72" /></div>
          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {loading ? <div className="flex min-h-[220px] items-center justify-center text-sm text-slate-500">Loading contractors...</div> : error ? <div className="flex min-h-[220px] items-center justify-center px-6 text-sm text-red-600">{error}</div> : filteredContractors.length === 0 ? <div className="flex min-h-[220px] items-center justify-center px-6 text-sm text-slate-500">No contractors found.</div> : <div className="w-full overflow-x-auto"><table className="min-w-[900px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Company Name</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Trade</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Contact Name</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Email</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Phone</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Active Status</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Actions</th></tr></thead><tbody>{filteredContractors.map((contractor) => <tr key={contractor.id} className="bg-white hover:bg-slate-50/80"><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{contractor.company_name}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.trade || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.contact_name || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.email || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.phone || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${contractor.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{contractor.active ? "Active" : "Inactive"}</span></td><td className="border border-slate-200 px-4 py-3 text-sm"><div className="flex items-center gap-3"><Link href={`/contractors/${contractor.id}`} className="font-medium text-indigo-600 hover:text-indigo-800">View Contractor</Link><button type="button" onClick={() => openEditModal(contractor)} className="font-medium text-slate-600 hover:text-slate-900">Edit</button></div></td></tr>)}</tbody></table></div>}
        </section>
      </div>
      {isModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-semibold">{editingContractor ? "Edit Contractor" : "Add Contractor"}</h2><button type="button" onClick={closeModal} className="text-sm text-slate-500">Close</button></div><form onSubmit={handleSubmit} className="space-y-4"><input aria-label="Company Name" placeholder="Company Name" value={form.company_name} onChange={(event) => setForm((current) => ({ ...current, company_name: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><input aria-label="Trade" placeholder="Trade" value={form.trade} onChange={(event) => setForm((current) => ({ ...current, trade: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><input aria-label="Contact Name" placeholder="Contact Name" value={form.contact_name} onChange={(event) => setForm((current) => ({ ...current, contact_name: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><input aria-label="Email" type="email" placeholder="Email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><input aria-label="Phone" placeholder="Phone" value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div><textarea aria-label="Notes" placeholder="Notes" rows={4} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />{editingContractor ? <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} />Active</label> : null}{formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div> : null}<div className="flex justify-end gap-3"><button type="button" onClick={closeModal} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white disabled:opacity-70">{saving ? "Saving..." : "Save Contractor"}</button></div></form></div></div> : null}
    </main>
  );
}
}
