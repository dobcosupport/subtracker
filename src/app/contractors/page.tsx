"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { logContractorStatusChange } from "@/services/activity";
import { createAssignment } from "@/services/assignments";
import { createContractor, getContractors, updateContractor } from "@/services/contractors";
import { getProjects } from "@/services/projects";
import type { Contractor, Project } from "@/types/database";

type NjPwcCandidate = {
  business_name: string | null;
  certificate_number: string | null;
  registration_date: string | null;
  expiration_date: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  source_url?: string | null;
};

// Persisted pending NJ PWC search request (browser sessionStorage, per-tab,
// no secrets/tokens/candidates). Tied to the exact normalized company name.
const NJ_PWC_STORAGE_KEY = "subtracker.njPwcSearch";
type NjPwcPersisted = { search_request_id: number; searched_company_name: string; request_created_at: string | null };

function normalizeNjPwcCompanyName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}
function saveNjPwcPersisted(record: NjPwcPersisted | null) {
  if (typeof window === "undefined") return;
  try {
    if (record) window.sessionStorage.setItem(NJ_PWC_STORAGE_KEY, JSON.stringify(record));
    else window.sessionStorage.removeItem(NJ_PWC_STORAGE_KEY);
  } catch { /* storage unavailable */ }
}
function readNjPwcPersisted(): NjPwcPersisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(NJ_PWC_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NjPwcPersisted;
    return Number.isInteger(parsed?.search_request_id) ? parsed : null;
  } catch { return null; }
}

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
  const [deactivatingId, setDeactivatingId] = useState<number | null>(null);

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
                      <td className="border border-slate-200 px-4 py-3 text-sm">
                        <div className="flex items-center gap-3">
                          <Link href={`/contractors/${contractor.id}`} className="font-medium text-indigo-600 hover:text-indigo-800">View Contractor</Link>
                          {contractor.active ? <button type="button" onClick={() => handleDeactivate(contractor)} disabled={deactivatingId === contractor.id} className="font-medium text-red-600 hover:text-red-800 disabled:opacity-50">{deactivatingId === contractor.id ? "Deactivating..." : "Deactivate"}</button> : null}
                        </div>
                      </td>
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
  address_1: "",
  address_2: "",
  city: "",
  state: "",
  zip_code: "",
  nj_pwc_number: "",
  nj_brc_number: "",
  ny_pwc_number: "",
  ny_brc_number: "",
  sage_erp_id: "",
  brc_name_control: "",
  brc_name_control_is_manual: false,
  material_vendor_only: false,
  notes: "",
  active: true,
};

function getBrcNameControl(companyName: string) {
  return companyName.replace(/[^\p{L}]/gu, "").slice(0, 4).toUpperCase();
}

export default function ContractorsPage() {
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState<number | null>(null);
  const [activatingId, setActivatingId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"active" | "inactive">("active");
  const [companyTypeFilter, setCompanyTypeFilter] = useState<"all" | "contractors" | "vendors">("all");
  const [sortColumn, setSortColumn] = useState<"company_name" | "trade" | "contact_name">("company_name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // NJ PWC attended search (Add Contractor workflow)
  const [njPwcSearching, setNjPwcSearching] = useState(false);
  const [njPwcRequestId, setNjPwcRequestId] = useState<number | null>(null);
  const [njPwcCandidates, setNjPwcCandidates] = useState<NjPwcCandidate[]>([]);
  const [njPwcResultsOpen, setNjPwcResultsOpen] = useState(false);
  const [njPwcNoMatch, setNjPwcNoMatch] = useState(false);
  const [njPwcMessage, setNjPwcMessage] = useState<string | null>(null);
  const [njPwcSelected, setNjPwcSelected] = useState<NjPwcCandidate | null>(null);
  const [njPwcImportOpen, setNjPwcImportOpen] = useState(false);
  const [njPwcImportChoices, setNjPwcImportChoices] = useState({ pwcNumber: false, address: false, city: false, state: false, zip: false, syncedRecord: true });
  const [njPwcResumeChecked, setNjPwcResumeChecked] = useState(false);
  const [njPwcPollStopped, setNjPwcPollStopped] = useState(false);

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

  const fetchProjects = async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    const { data, error: projectsLoadError } = await getProjects();

    if (projectsLoadError) {
      setProjectsError(projectsLoadError.message || "Unable to load projects.");
      setProjects([]);
      setProjectsLoading(false);
      return;
    }

    setProjects(data ?? []);
    setProjectsLoading(false);
  };

  useEffect(() => {
    void fetchContractors();
    void fetchProjects();
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("type") === "vendors") {
      setCompanyTypeFilter("vendors");
    }
  }, []);

  const activeContractors = useMemo(() => contractors.filter((contractor) => contractor.active), [contractors]);
  const inactiveContractors = useMemo(() => contractors.filter((contractor) => !contractor.active), [contractors]);

  const filteredContractors = useMemo(() => {
    const term = search.trim().toLowerCase();
    const tabContractors = activeTab === "active" ? activeContractors : inactiveContractors;
    const typeFilteredContractors = companyTypeFilter === "all" ? tabContractors : tabContractors.filter((contractor) => companyTypeFilter === "vendors" ? Boolean(contractor.material_vendor_only) : !contractor.material_vendor_only);

    const matchingContractors = typeFilteredContractors.filter((contractor) =>
      [contractor.company_name, contractor.trade, contractor.contact_name, contractor.email, contractor.phone].some((value) =>
        (value ?? "").toLowerCase().includes(term)
      )
    );

    return [...matchingContractors].sort((left, right) => {
      const comparison = (left[sortColumn] ?? "").localeCompare(right[sortColumn] ?? "", undefined, { sensitivity: "base" });
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [activeTab, activeContractors, inactiveContractors, companyTypeFilter, search, sortColumn, sortDirection]);

  const handleSort = (column: "company_name" | "trade" | "contact_name") => {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortColumn(column);
    setSortDirection("asc");
  };

  const sortIndicator = (column: "company_name" | "trade" | "contact_name") => {
    if (sortColumn !== column) {
      return "↕";
    }

    return sortDirection === "asc" ? "↑" : "↓";
  };

  const activeProjects = useMemo(() => projects.filter((project) => project.status === "Active"), [projects]);

  const toggleProjectSelection = (projectId: string) => {
    setSelectedProjectIds((current) =>
      current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]
    );
  };

  const openAddModal = () => {
    setEditingContractor(null);
    setForm(emptyForm);
    setSelectedProjectIds([]);
    setFormError(null);
    setSuccessMessage(null);
    setNjPwcResumeChecked(false);
    setIsModalOpen(true);
  };

  const handleCompanyNameChange = (companyName: string) => {
    setForm((current) => ({
      ...current,
      company_name: companyName,
      brc_name_control: current.brc_name_control_is_manual
        ? current.brc_name_control
        : getBrcNameControl(companyName),
    }));
  };

  const handleBrcNameControlChange = (value: string) => {
    setForm((current) => ({
      ...current,
      brc_name_control: value.toUpperCase().slice(0, 4),
      brc_name_control_is_manual: true,
    }));
  };

  const openEditModal = (contractor: Contractor) => {
    setEditingContractor(contractor);
    setForm({
      company_name: contractor.company_name,
      trade: contractor.trade ?? "",
      contact_name: contractor.contact_name ?? "",
      email: contractor.email ?? "",
      phone: contractor.phone ?? "",
      address_1: contractor.address_1 ?? "",
      address_2: contractor.address_2 ?? "",
      city: contractor.city ?? "",
      state: contractor.state ?? "",
      zip_code: contractor.zip_code ?? "",
      nj_pwc_number: contractor.nj_pwc_number ?? "",
      nj_brc_number: contractor.nj_brc_number ?? "",
      ny_pwc_number: contractor.ny_pwc_number ?? "",
      ny_brc_number: contractor.ny_brc_number ?? "",
      sage_erp_id: contractor.sage_erp_id ?? "",
      brc_name_control: contractor.brc_name_control_is_manual
        ? contractor.brc_name_control ?? ""
        : contractor.brc_name_control ?? getBrcNameControl(contractor.company_name),
      brc_name_control_is_manual: contractor.brc_name_control_is_manual ?? false,
      material_vendor_only: contractor.material_vendor_only ?? false,
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
    setSelectedProjectIds([]);
    setFormError(null);
    resetNjPwcSearch();
  };

  // ---- NJ PWC attended search (Add Contractor) ------------------------
  function resetNjPwcSearch() {
    setNjPwcSearching(false);
    setNjPwcRequestId(null);
    setNjPwcCandidates([]);
    setNjPwcResultsOpen(false);
    setNjPwcNoMatch(false);
    setNjPwcMessage(null);
    setNjPwcSelected(null);
    setNjPwcImportOpen(false);
    setNjPwcPollStopped(false);
    saveNjPwcPersisted(null);
  }

  // Apply a fetched search-request result to the UI state.
  const applyNjPwcResult = (result: { status?: string; candidates?: NjPwcCandidate[]; error_message?: string | null }) => {
    if (result.status === "pending") {
      setNjPwcSearching(true);
      setNjPwcPollStopped(false);
      setNjPwcMessage("NJ PWC search is still waiting for the RPA process.");
      return;
    }
    const candidates = result.candidates ?? [];
    setNjPwcSearching(false);
    if (result.status === "completed" && candidates.length > 0) {
      setNjPwcCandidates(candidates);
      setNjPwcResultsOpen(true);
      setNjPwcMessage(null);
    } else if (result.status === "no_match" || (result.status === "completed" && candidates.length === 0)) {
      setNjPwcNoMatch(true);
      setNjPwcMessage(null);
    } else {
      setNjPwcMessage(result.error_message ?? "NJ PWC search did not complete. You may continue entering the contractor manually.");
    }
  };

  const handleNjPwcSearch = async () => {
    if (!form.company_name.trim()) {
      setFormError("Enter a Company Name before searching NJ PWC.");
      return;
    }
    setFormError(null);
    setNjPwcSearching(true);
    setNjPwcNoMatch(false);
    setNjPwcMessage(null);
    setNjPwcCandidates([]);
    const companyName = form.company_name.trim();
    try {
      // Duplicate prevention: reuse the current user's latest pending/completed
      // request for the exact company name before creating a new one.
      const latestResponse = await adminFetch(`/api/contractors/nj-pwc-search/latest?company_name=${encodeURIComponent(companyName)}`);
      if (latestResponse.ok) {
        const latest = await latestResponse.json() as { found?: boolean; search_request_id?: number; status?: string; candidates?: NjPwcCandidate[]; error_message?: string | null };
        if (latest.found && latest.search_request_id && (latest.status === "pending" || latest.status === "completed")) {
          setNjPwcRequestId(latest.search_request_id);
          saveNjPwcPersisted({ search_request_id: latest.search_request_id, searched_company_name: normalizeNjPwcCompanyName(companyName), request_created_at: null });
          applyNjPwcResult(latest);
          return;
        }
      }

      const response = await adminFetch("/api/contractors/nj-pwc-search", {
        method: "POST",
        body: JSON.stringify({ company_name: companyName, zip_code: form.zip_code.trim() || undefined, city: form.city.trim() || undefined, state: form.state.trim() || undefined }),
      });
      const result = await response.json() as { search_request_id?: number; error?: string };
      if (!response.ok || !result.search_request_id) throw new Error(result.error ?? "Unable to start NJ PWC search.");
      setNjPwcRequestId(result.search_request_id);
      saveNjPwcPersisted({ search_request_id: result.search_request_id, searched_company_name: normalizeNjPwcCompanyName(companyName), request_created_at: new Date().toISOString() });
      setNjPwcMessage("NJ PWC search request created. Waiting for the RPA process to return results.");
    } catch (reason) {
      setNjPwcSearching(false);
      setNjPwcMessage(reason instanceof Error ? reason.message : "Unable to start NJ PWC search.");
    }
  };

  // Poll the search request until the RPA posts results back.
  useEffect(() => {
    if (njPwcRequestId === null) return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const response = await adminFetch(`/api/contractors/nj-pwc-search/${njPwcRequestId}`);
        const result = await response.json() as { status?: string; candidates?: NjPwcCandidate[]; error_message?: string | null };
        if (cancelled) return;
        if (!response.ok) throw new Error("Unable to read NJ PWC search status.");
        if (result.status === "pending") {
          setNjPwcMessage("NJ PWC search request created. Waiting for the RPA process to return results.");
          if (attempts < 60) {
            window.setTimeout(poll, 3000);
            return;
          }
          // Attempt limit reached: stop polling but preserve the request so it
          // can be recovered later via Check Search Status.
          setNjPwcSearching(false);
          setNjPwcPollStopped(true);
          setNjPwcMessage("The NJ PWC search is still pending. The RPA process may not be running or may need additional time.");
          return;
        }
        const candidates = result.candidates ?? [];
        setNjPwcSearching(false);
        setNjPwcPollStopped(false);
        if (result.status === "completed" && candidates.length > 0) {
          setNjPwcCandidates(candidates);
          setNjPwcResultsOpen(true);
          setNjPwcMessage(null);
        } else if (result.status === "no_match" || (result.status === "completed" && candidates.length === 0)) {
          setNjPwcNoMatch(true);
          setNjPwcMessage(null);
        } else {
          setNjPwcMessage(result.error_message ?? "NJ PWC search did not complete. You may continue entering the contractor manually.");
        }
      } catch (reason) {
        if (cancelled) return;
        setNjPwcSearching(false);
        setNjPwcMessage(reason instanceof Error ? reason.message : "NJ PWC search failed. You may continue manually.");
      }
    };
    const timer = window.setTimeout(poll, 2000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [njPwcRequestId]);

  // Resume a pending/completed NJ PWC search when the Add Contractor modal
  // opens and the browser already has a persisted request for this company.
  useEffect(() => {
    if (!isModalOpen || editingContractor || njPwcResumeChecked) return;
    setNjPwcResumeChecked(true);
    const persisted = readNjPwcPersisted();
    if (!persisted) return;
    if (persisted.searched_company_name !== normalizeNjPwcCompanyName(form.company_name)) return;
    if (njPwcRequestId !== null) return;
    setNjPwcRequestId(persisted.search_request_id);
    // The polling effect picks it up from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, editingContractor, njPwcResumeChecked]);

  // Manual "Check Search Status" — re-reads the current request on demand.
  const handleCheckNjPwcStatus = async () => {
    if (njPwcRequestId === null) return;
    try {
      const response = await adminFetch(`/api/contractors/nj-pwc-search/${njPwcRequestId}`);
      const result = await response.json() as { status?: string; candidates?: NjPwcCandidate[]; error_message?: string | null };
      if (response.status === 404) {
        resetNjPwcSearch();
        setNjPwcMessage("The saved NJ PWC search request was not found. You may start a new search.");
        return;
      }
      if (!response.ok) throw new Error("Unable to read NJ PWC search status.");
      setNjPwcPollStopped(false);
      applyNjPwcResult(result);
    } catch (reason) {
      setNjPwcMessage(reason instanceof Error ? reason.message : "Unable to read NJ PWC search status.");
    }
  };

  const handleStartNewNjPwcSearch = async () => {
    const confirmed = window.confirm("Start a new NJ PWC search? This abandons the existing pending request for this company.");
    if (!confirmed) return;
    resetNjPwcSearch();
    await handleNjPwcSearch();
  };

  const handleNjPwcSelect = (candidate: NjPwcCandidate) => {
    setNjPwcSelected(candidate);
    setNjPwcResultsOpen(false);
    // Default: check fields that are blank in the form; never auto-overwrite
    // values the user already entered.
    setNjPwcImportChoices({
      pwcNumber: form.nj_pwc_number.trim() === "",
      address: form.address_1.trim() === "",
      city: form.city.trim() === "",
      state: form.state.trim() === "",
      zip: form.zip_code.trim() === "",
      syncedRecord: true,
    });
    setNjPwcImportOpen(true);
  };

  const handleNjPwcImport = () => {
    if (!njPwcSelected) return;
    setForm((current) => ({
      ...current,
      nj_pwc_number: njPwcImportChoices.pwcNumber && njPwcSelected.certificate_number ? njPwcSelected.certificate_number : current.nj_pwc_number,
      address_1: njPwcImportChoices.address && njPwcSelected.address ? njPwcSelected.address : current.address_1,
      city: njPwcImportChoices.city && njPwcSelected.city ? njPwcSelected.city : current.city,
      state: njPwcImportChoices.state && njPwcSelected.state ? njPwcSelected.state : current.state,
      zip_code: njPwcImportChoices.zip && njPwcSelected.zip_code ? njPwcSelected.zip_code : current.zip_code,
    }));
    setNjPwcImportOpen(false);
    // Candidate selected + imported: clear the persisted pending request,
    // but keep the selected match until the contractor is saved.
    saveNjPwcPersisted(null);
    setNjPwcMessage("NJ PWC information imported into the form. Complete the remaining fields and save the contractor.");
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

    if (form.brc_name_control.trim().length > 4) {
      setFormError("BRC Name Control must be 4 characters or fewer.");
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
      address_1: form.address_1.trim() || null,
      address_2: form.address_2.trim() || null,
      city: form.city.trim() || null,
      state: form.state.trim() || null,
      zip_code: form.zip_code.trim() || null,
      nj_pwc_number: form.nj_pwc_number.trim() || null,
      nj_brc_number: form.nj_brc_number.trim() || null,
      ny_pwc_number: form.ny_pwc_number.trim() || null,
      ny_brc_number: form.ny_brc_number.trim() || null,
      sage_erp_id: form.sage_erp_id.trim() || null,
      brc_name_control: form.brc_name_control.trim() || null,
      brc_name_control_is_manual: form.brc_name_control_is_manual,
      material_vendor_only: form.material_vendor_only,
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

    if (editingContractor && editingContractor.active !== form.active) {
      await logContractorStatusChange(
        editingContractor.id,
        fields.company_name,
        editingContractor.active ? "Active" : "Inactive",
        form.active ? "Active" : "Inactive"
      );
    }

    const newContractorId = !editingContractor ? result.data?.[0]?.id : null;
    if (newContractorId && selectedProjectIds.length > 0) {
      const assignedDate = new Date().toISOString().slice(0, 10);
      await Promise.all(
        selectedProjectIds.map((projectId) =>
          createAssignment({ contractor_id: newContractorId, project_id: Number(projectId), assigned_date: assignedDate, active: true })
        )
      );
    }

    // After the contractor is successfully created, create the NJ PWC
    // Synced Compliance Record + Review Queue entry from the preserved
    // selected match. Never runs if contractor creation failed.
    if (newContractorId && njPwcSelected) {
      try {
        await adminFetch("/api/contractors/nj-pwc-import", {
          method: "POST",
          body: JSON.stringify({ contractor_id: newContractorId, candidate: njPwcSelected, create_synced_record: njPwcImportChoices.syncedRecord }),
        });
      } catch {
        // Non-fatal: the contractor was created; the synced/review entry can
        // be regenerated from the Compliance Sync admin. Do not block the save.
      }
      // Contractor saved + synced record created: clear all temp NJ PWC state.
      saveNjPwcPersisted(null);
    }

    await fetchContractors();
    closeModal();
    setSaving(false);
    setSuccessMessage(editingContractor ? "Contractor updated successfully." : "Contractor added successfully.");
  };

  const handleDeactivate = async (contractor: Contractor) => {
    setDeactivatingId(contractor.id);
    const { error: deactivateError } = await updateContractor(contractor.id, { active: false });

    if (deactivateError) {
      setError(deactivateError.message || "Unable to deactivate contractor.");
      setDeactivatingId(null);
      return;
    }

    await logContractorStatusChange(contractor.id, contractor.company_name, "Active", "Inactive");
    await fetchContractors();
    closeModal();
    setDeactivatingId(null);
    setActiveTab("inactive");
    setSuccessMessage("Contractor deactivated successfully.");
  };

  const handleActivate = async (contractor: Contractor) => {
    setActivatingId(contractor.id);
    const { error: activateError } = await updateContractor(contractor.id, { active: true });

    if (activateError) {
      setError(activateError.message || "Unable to activate contractor.");
      setActivatingId(null);
      return;
    }

    await logContractorStatusChange(contractor.id, contractor.company_name, "Inactive", "Active");
    await fetchContractors();
    closeModal();
    setActivatingId(null);
    setActiveTab("active");
    setSuccessMessage("Contractor activated successfully.");
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="w-full max-w-none">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Contractor Management</h1></div><button type="button" onClick={openAddModal} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800">Add Contractor</button></div>
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-xl font-semibold text-slate-900">Contractor Directory</h2><div className="mt-2 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">{(["active", "inactive"] as const).map((tab) => { const isSelected = activeTab === tab; const count = tab === "active" ? activeContractors.length : inactiveContractors.length; return <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${isSelected ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"}`}>{tab === "active" ? "Active Contractors" : "Inactive Contractors"} ({count})</button>; })}</div></div><div className="flex flex-col gap-3 sm:flex-row sm:items-center"><select aria-label="Company Type Filter" value={companyTypeFilter} onChange={(event) => setCompanyTypeFilter(event.target.value as "all" | "contractors" | "vendors")} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm sm:w-56"><option value="all">All Companies</option><option value="contractors">Contractors Only</option><option value="vendors">Material Vendors Only</option></select><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search contractors" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm sm:w-72" /></div></div>
          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {loading ? <div className="flex min-h-[220px] items-center justify-center text-sm text-slate-500">Loading contractors...</div> : error ? <div className="flex min-h-[220px] items-center justify-center px-6 text-sm text-red-600">{error}</div> : filteredContractors.length === 0 ? <div className="flex min-h-[220px] items-center justify-center px-6 text-sm text-slate-500">{activeTab === "active" ? "No active contractors found." : "No inactive contractors found."}</div> : <div className="w-full overflow-x-auto"><table className="w-full min-w-[720px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-4 py-3 text-sm font-semibold"><button type="button" onClick={() => handleSort("company_name")} className="inline-flex items-center gap-2 hover:text-slate-900">Company Name <span aria-hidden="true">{sortIndicator("company_name")}</span></button></th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold"><button type="button" onClick={() => handleSort("trade")} className="inline-flex items-center gap-2 hover:text-slate-900">Trade <span aria-hidden="true">{sortIndicator("trade")}</span></button></th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold"><button type="button" onClick={() => handleSort("contact_name")} className="inline-flex items-center gap-2 hover:text-slate-900">Contact Name <span aria-hidden="true">{sortIndicator("contact_name")}</span></button></th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Email</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Phone</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Active Status</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Actions</th></tr></thead><tbody>{filteredContractors.map((contractor) => <tr key={contractor.id} className="bg-white hover:bg-slate-50/80"><td className="border border-slate-200 px-4 py-3 text-sm font-medium"><Link href={`/contractors/${contractor.id}`} className="text-blue-600 hover:underline cursor-pointer">{contractor.company_name}</Link></td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.trade || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.contact_name || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.email || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractor.phone || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${contractor.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{contractor.active ? "Active" : "Inactive"}</span></td><td className="border border-slate-200 px-4 py-3 text-sm"><div className="flex items-center gap-3"><Link href={`/contractors/${contractor.id}`} className="font-medium text-indigo-600 hover:text-indigo-800">View Contractor</Link><button type="button" onClick={() => openEditModal(contractor)} className="font-medium text-slate-600 hover:text-slate-900">Edit</button>{contractor.active ? <button type="button" onClick={() => void handleDeactivate(contractor)} disabled={deactivatingId === contractor.id} className="font-medium text-red-600 hover:text-red-800 disabled:opacity-50">{deactivatingId === contractor.id ? "Deactivating..." : "Deactivate"}</button> : <button type="button" onClick={() => void handleActivate(contractor)} disabled={activatingId === contractor.id} className="font-medium text-emerald-600 hover:text-emerald-800 disabled:opacity-50">{activatingId === contractor.id ? "Activating..." : "Activate"}</button>}</div></td></tr>)}</tbody></table></div>}
        </section>
      </div>
      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">{editingContractor ? "Edit Contractor" : "Add Contractor"}</h2>
              <button type="button" onClick={closeModal} className="text-sm text-slate-500">Close</button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input aria-label="Company Name" placeholder="Company Name" value={form.company_name} onChange={(event) => handleCompanyNameChange(event.target.value)} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                {!editingContractor ? <button type="button" onClick={() => void handleNjPwcSearch()} disabled={njPwcSearching} className="whitespace-nowrap rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-60">{njPwcSearching ? "Searching…" : "Search NJ PWC"}</button> : null}
              </div>
              {njPwcMessage ? <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">{njPwcMessage}</p> : null}
              {!editingContractor && njPwcRequestId !== null && (njPwcPollStopped || !njPwcSearching) && !njPwcResultsOpen && !njPwcSelected ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void handleCheckNjPwcStatus()} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-medium text-indigo-600 hover:bg-indigo-50">Check Search Status</button>
                  <button type="button" onClick={() => void handleStartNewNjPwcSearch()} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">Start New Search</button>
                  <button type="button" onClick={() => resetNjPwcSearch()} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50">Continue Without NJ PWC Search</button>
                </div>
              ) : null}
              {njPwcNoMatch ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">No NJ PWC registration was found for this company. You may continue entering the contractor manually.</p> : null}
              {njPwcSelected && !njPwcImportOpen ? <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">NJ PWC match selected{njPwcSelected.certificate_number ? ` — Certificate # ${njPwcSelected.certificate_number}` : ""}. It will be linked after the contractor is saved.</p> : null}
              <label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={form.material_vendor_only} onChange={(event) => setForm((current) => ({ ...current, material_vendor_only: event.target.checked }))} />Material Vendor Only</label>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <input aria-label="Trade" placeholder="Trade" value={form.trade} onChange={(event) => setForm((current) => ({ ...current, trade: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="Contact Name" placeholder="Contact Name" value={form.contact_name} onChange={(event) => setForm((current) => ({ ...current, contact_name: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <input aria-label="Email" type="email" placeholder="Email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="Phone" placeholder="Phone" value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              </div>
              <input aria-label="Address 1" placeholder="Address 1" value={form.address_1} onChange={(event) => setForm((current) => ({ ...current, address_1: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              <input aria-label="Address 2" placeholder="Address 2" value={form.address_2} onChange={(event) => setForm((current) => ({ ...current, address_2: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              <div className="grid grid-cols-[minmax(0,1fr)_5rem_6rem] gap-3">
                <input aria-label="City" placeholder="City" value={form.city} onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="State" placeholder="State" value={form.state} onChange={(event) => setForm((current) => ({ ...current, state: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="Zip Code" placeholder="Zip Code" value={form.zip_code} onChange={(event) => setForm((current) => ({ ...current, zip_code: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3 min-[480px]:grid-cols-4">
                <input aria-label="NJ PWC #" placeholder="NJ PWC #" value={form.nj_pwc_number} onChange={(event) => setForm((current) => ({ ...current, nj_pwc_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="NJ BRC #" placeholder="NJ BRC #" value={form.nj_brc_number} onChange={(event) => setForm((current) => ({ ...current, nj_brc_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="NY PWC #" placeholder="NY PWC #" value={form.ny_pwc_number} onChange={(event) => setForm((current) => ({ ...current, ny_pwc_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="NY BRC #" placeholder="NY BRC #" value={form.ny_brc_number} onChange={(event) => setForm((current) => ({ ...current, ny_brc_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              </div>
              <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
                <input aria-label="BRC Name Control" placeholder="BRC Name Control" maxLength={4} value={form.brc_name_control} onChange={(event) => handleBrcNameControlChange(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
                <input aria-label="Sage ERP ID" placeholder="Sage ERP ID" value={form.sage_erp_id} onChange={(event) => setForm((current) => ({ ...current, sage_erp_id: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              </div>
              <textarea aria-label="Notes" placeholder="Notes" rows={4} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
              {!editingContractor ? <div><label className="mb-1 block text-sm font-medium text-slate-700">Assign Projects</label>{projectsLoading ? <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-500">Loading projects...</p> : projectsError ? <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{projectsError}</p> : activeProjects.length === 0 ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">No projects available.</p> : <div className="max-h-40 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">{activeProjects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={selectedProjectIds.includes(String(project.id))} onChange={() => toggleProjectSelection(String(project.id))} />{project.project_number} {project.project_name}</label>)}</div>}</div> : null}
              {editingContractor ? <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} />Active</label> : null}
              {formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div> : null}
              <div className="flex justify-end gap-3">
                {editingContractor?.active ? <button type="button" onClick={() => void handleDeactivate(editingContractor)} disabled={deactivatingId === editingContractor.id} className="mr-auto rounded-xl border border-red-200 px-4 py-2.5 text-sm text-red-600 disabled:opacity-50">{deactivatingId === editingContractor.id ? "Deactivating..." : "Deactivate"}</button> : editingContractor ? <button type="button" onClick={() => void handleActivate(editingContractor)} disabled={activatingId === editingContractor.id} className="mr-auto rounded-xl border border-emerald-200 px-4 py-2.5 text-sm text-emerald-700 disabled:opacity-50">{activatingId === editingContractor.id ? "Activating..." : "Activate"}</button> : null}
                <button type="button" onClick={closeModal} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button>
                <button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white disabled:opacity-70">{saving ? "Saving..." : "Save Contractor"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {njPwcResultsOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">NJ PWC Registry Matches</h2>
              <button type="button" onClick={() => setNjPwcResultsOpen(false)} className="text-sm text-slate-500">Cancel</button>
            </div>
            <p className="text-sm text-slate-500">Select the correct company. {njPwcCandidates.length > 1 ? "Multiple matches were found — choose one to continue." : "Review the match to continue."}</p>
            <div className="mt-4 space-y-3">
              {njPwcCandidates.map((candidate, index) => (
                <div key={index} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{candidate.business_name ?? "—"}</p>
                      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-3">
                        <div><dt className="font-semibold text-slate-400">Certificate #</dt><dd>{candidate.certificate_number ?? "—"}</dd></div>
                        <div><dt className="font-semibold text-slate-400">Registration Date</dt><dd>{candidate.registration_date ?? "—"}</dd></div>
                        <div><dt className="font-semibold text-slate-400">Expiration Date</dt><dd>{candidate.expiration_date ?? "—"}</dd></div>
                        <div className="col-span-2 sm:col-span-3"><dt className="font-semibold text-slate-400">Address</dt><dd>{[candidate.address, candidate.city, candidate.state, candidate.zip_code].filter(Boolean).join(", ") || "—"}</dd></div>
                      </dl>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button type="button" onClick={() => handleNjPwcSelect(candidate)} className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2 text-sm text-white">Select Match</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end"><button type="button" onClick={() => setNjPwcResultsOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button></div>
          </div>
        </div>
      ) : null}

      {njPwcImportOpen && njPwcSelected ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold">Import NJ PWC Information</h2>
            <p className="mt-1 text-sm text-slate-500">Compare the registry values against the current form values and choose what to import. Fields already entered are unchecked by default.</p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-50"><tr><th className="border border-slate-200 px-3 py-2">Field</th><th className="border border-slate-200 px-3 py-2">Registry Value</th><th className="border border-slate-200 px-3 py-2">Current Form Value</th><th className="border border-slate-200 px-3 py-2">Import</th></tr></thead>
                <tbody>
                  {([
                    { key: "pwcNumber", label: "NJ PWC #", registry: njPwcSelected.certificate_number, current: form.nj_pwc_number },
                    { key: "address", label: "Address 1", registry: njPwcSelected.address, current: form.address_1 },
                    { key: "city", label: "City", registry: njPwcSelected.city, current: form.city },
                    { key: "state", label: "State", registry: njPwcSelected.state, current: form.state },
                    { key: "zip", label: "ZIP Code", registry: njPwcSelected.zip_code, current: form.zip_code },
                  ] as const).map((row) => (
                    <tr key={row.key}>
                      <td className="border border-slate-200 px-3 py-2 font-medium">{row.label}</td>
                      <td className="border border-slate-200 px-3 py-2">{row.registry ?? "—"}</td>
                      <td className="border border-slate-200 px-3 py-2">{row.current.trim() || "—"}</td>
                      <td className="border border-slate-200 px-3 py-2"><input type="checkbox" aria-label={`Import ${row.label}`} checked={njPwcImportChoices[row.key]} disabled={!row.registry} onChange={(event) => setNjPwcImportChoices((current) => ({ ...current, [row.key]: event.target.checked }))} /></td>
                    </tr>
                  ))}
                  <tr>
                    <td className="border border-slate-200 px-3 py-2 font-medium">Registration Date</td>
                    <td className="border border-slate-200 px-3 py-2">{njPwcSelected.registration_date ?? "—"}</td>
                    <td className="border border-slate-200 px-3 py-2 text-slate-400">Synced record</td>
                    <td className="border border-slate-200 px-3 py-2 text-slate-400">—</td>
                  </tr>
                  <tr>
                    <td className="border border-slate-200 px-3 py-2 font-medium">Expiration Date</td>
                    <td className="border border-slate-200 px-3 py-2">{njPwcSelected.expiration_date ?? "—"}</td>
                    <td className="border border-slate-200 px-3 py-2 text-slate-400">Synced record</td>
                    <td className="border border-slate-200 px-3 py-2 text-slate-400">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <label className="mt-4 flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={njPwcImportChoices.syncedRecord} onChange={(event) => setNjPwcImportChoices((current) => ({ ...current, syncedRecord: event.target.checked }))} />Create NJ PWC Synced Compliance Record</label>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setNjPwcImportOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button>
              <button type="button" onClick={handleNjPwcImport} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">Import Selected Information</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
