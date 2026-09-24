"use client";

import { useEffect, useMemo, useState } from "react";
import { getContractors } from "@/services/contractors";
import {
  createComplianceRecord,
  getComplianceRecords,
  getComplianceTypes,
} from "@/services/compliance";
import type { ComplianceStatus, ComplianceStatusRecord, ComplianceType, Contractor } from "@/types/database";

const emptyForm = {
  contractor_id: "",
  compliance_type_id: "",
  registration_number: "",
  effective_date: "",
  expiration_date: "",
  verified_date: "",
  verified_by: "",
  notes: "",
};

const statusStyles: Record<ComplianceStatus, string> = {
  Active: "bg-emerald-100 text-emerald-700",
  "90 Day": "bg-amber-100 text-amber-700",
  "60 Day": "bg-orange-100 text-orange-700",
  "30 Day": "bg-red-100 text-red-700",
  Expired: "bg-[#7f1d1d] text-white",
  "Missing Information": "bg-sky-100 text-sky-700",
};

export default function CompliancePage() {
  const [records, setRecords] = useState<ComplianceStatusRecord[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [complianceTypes, setComplianceTypes] = useState<ComplianceType[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchComplianceData = async () => {
    setLoading(true);
    setError(null);

    const [{ data: recordData, error: recordsError }, { data: contractorData, error: contractorsError }, { data: typeData, error: typesError }] = await Promise.all([
      getComplianceRecords(),
      getContractors(),
      getComplianceTypes(),
    ]);

    const loadError = recordsError || contractorsError || typesError;

    if (loadError) {
      setError(loadError.message || "Unable to load compliance records.");
      setRecords([]);
      setLoading(false);
      return;
    }

    setRecords(recordData ?? []);
    setContractors(contractorData ?? []);
    setComplianceTypes(typeData ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void fetchComplianceData();
  }, []);

  const filteredRecords = useMemo(() => {
    const term = search.trim().toLowerCase();

    const matchingRecords = term
      ? records.filter((record) =>
          [record.company_name, record.compliance_name, record.registration_number].some((value) =>
            (value ?? "").toLowerCase().includes(term)
          )
        )
      : records;

    return [...matchingRecords].sort((left, right) => {
      if (!left.expiration_date && !right.expiration_date) {
        return 0;
      }

      if (!left.expiration_date) {
        return 1;
      }

      if (!right.expiration_date) {
        return -1;
      }

      return left.expiration_date.localeCompare(right.expiration_date);
    });
  }, [records, search]);

  const isExpiringSoon = (record: ComplianceStatusRecord) =>
    record.days_remaining !== null && record.days_remaining >= 0 && record.days_remaining <= 90;

  const closeModal = () => {
    setIsModalOpen(false);
    setForm(emptyForm);
    setFormError(null);
  };

  const handleCreateRecord = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.contractor_id) {
      setFormError("Contractor is required.");
      return;
    }

    if (!form.compliance_type_id) {
      setFormError("Compliance Type is required.");
      return;
    }

    setSaving(true);
    setFormError(null);

    const { error: createError } = await createComplianceRecord({
      contractor_id: Number(form.contractor_id),
      compliance_type_id: Number(form.compliance_type_id),
      registration_number: form.registration_number.trim() || null,
      effective_date: form.effective_date || null,
      expiration_date: form.expiration_date || null,
      verified_date: form.verified_date || null,
      verified_by: form.verified_by.trim() || null,
      verification_source: null,
      is_current: true,
      active: true,
      notes: form.notes.trim() || null,
    });

    if (createError) {
      setFormError(createError.message || "Unable to create compliance record.");
      setSaving(false);
      return;
    }

    await fetchComplianceData();
    closeModal();
    setSaving(false);
    setSuccessMessage("Compliance record added successfully.");
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Compliance Tracking</h1>
          </div>
        </div>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div><h2 className="text-xl font-semibold text-slate-900">Compliance Directory</h2><p className="mt-1 text-sm text-slate-500">Total Compliance Records: {records.length}</p></div>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search compliance records" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white sm:w-80" />
          </div>

          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {loading ? <div className="flex min-h-[220px] items-center justify-center text-sm font-medium text-slate-500">Loading compliance records...</div> : error ? <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-red-600">{error}</div> : filteredRecords.length === 0 ? <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-slate-500">No compliance records found.</div> : (
            <div className="w-full overflow-x-auto"><table className="min-w-[1050px] border-collapse text-left"><thead className="bg-slate-50"><tr>
              <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Contractor Name</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Compliance Type</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Registration Number</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Effective Date</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Expiration Date</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Days Remaining</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Calculated Status</th>
            </tr></thead><tbody>{filteredRecords.map((record) => <tr key={record.compliance_record_id} className={`${isExpiringSoon(record) ? "bg-amber-50" : "bg-white"} hover:bg-slate-50/80`}><td className="border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800">{record.company_name}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.compliance_name}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.registration_number || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.effective_date || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.expiration_date || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.days_remaining ?? "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[record.calculated_status]}`}>{record.calculated_status}</span></td></tr>)}</tbody></table></div>
          )}
        </section>
      </div>

      {isModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"><div className="mb-5 flex items-center justify-between gap-4"><h2 className="text-xl font-semibold text-slate-900">Add Compliance Record</h2><button type="button" onClick={closeModal} className="text-sm font-medium text-slate-500 hover:text-slate-700">Close</button></div><form onSubmit={handleCreateRecord} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div><label htmlFor="contractor_id" className="mb-1 block text-sm font-medium text-slate-700">Contractor <span className="text-red-500">*</span></label><select id="contractor_id" value={form.contractor_id} onChange={(event) => setForm((current) => ({ ...current, contractor_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700"><option value="">Select contractor</option>{contractors.map((contractor) => <option key={contractor.id} value={contractor.id}>{contractor.company_name}</option>)}</select></div><div><label htmlFor="compliance_type_id" className="mb-1 block text-sm font-medium text-slate-700">Compliance Type <span className="text-red-500">*</span></label><select id="compliance_type_id" value={form.compliance_type_id} onChange={(event) => setForm((current) => ({ ...current, compliance_type_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700"><option value="">Select compliance type</option>{complianceTypes.map((type) => <option key={type.id} value={type.id}>{type.compliance_name}</option>)}</select></div></div>
        <div><label htmlFor="registration_number" className="mb-1 block text-sm font-medium text-slate-700">Registration Number</label><input id="registration_number" type="text" value={form.registration_number} onChange={(event) => setForm((current) => ({ ...current, registration_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" /></div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3"><div><label htmlFor="effective_date" className="mb-1 block text-sm font-medium text-slate-700">Effective Date</label><input id="effective_date" type="date" value={form.effective_date} onChange={(event) => setForm((current) => ({ ...current, effective_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" /></div><div><label htmlFor="expiration_date" className="mb-1 block text-sm font-medium text-slate-700">Expiration Date</label><input id="expiration_date" type="date" value={form.expiration_date} onChange={(event) => setForm((current) => ({ ...current, expiration_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" /></div><div><label htmlFor="verified_date" className="mb-1 block text-sm font-medium text-slate-700">Verified Date</label><input id="verified_date" type="date" value={form.verified_date} onChange={(event) => setForm((current) => ({ ...current, verified_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" /></div></div>
        <div><label htmlFor="verified_by" className="mb-1 block text-sm font-medium text-slate-700">Verified By</label><input id="verified_by" type="text" value={form.verified_by} onChange={(event) => setForm((current) => ({ ...current, verified_by: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" /></div>
        <div><label htmlFor="notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label><textarea id="notes" rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" /></div>
        {formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div> : null}<div className="flex justify-end gap-3 pt-2"><button type="button" onClick={closeModal} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-70">{saving ? "Saving..." : "Save Record"}</button></div>
      </form></div></div> : null}
    </main>
  );
}
