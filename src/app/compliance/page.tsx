"use client";

import { useEffect, useMemo, useState } from "react";
import { getContractors } from "@/services/contractors";
import {
  createComplianceRecord,
  getComplianceRecords,
  getComplianceTypes,
} from "@/services/compliance";
import type { ComplianceStatus, ComplianceStatusRecord, ComplianceType, Contractor } from "@/types/database";
import { complianceFilterLabels, matchesComplianceFilter, type ComplianceDirectoryFilter } from "@/services/compliance-directory";
import Style3SummaryCards from "@/components/style3/Style3SummaryCards";
import Style3Panel from "@/components/style3/Style3Panel";
import shared from "@/components/style3/style3.module.css";
import styles from "@/components/style3/operations.module.css";

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
  Active: shared.good,
  "90 Day": shared.yellow,
  "60 Day": shared.yellow,
  "30 Day": shared.red,
  Expired: shared.red,
  "Missing Information": shared.neutral,
};

const statusChart: readonly { key: ComplianceStatus; label: string; tone: string }[] = [
  { key: "Active", label: "Current", tone: styles.good },
  { key: "90 Day", label: "90 Day", tone: styles.yellow },
  { key: "60 Day", label: "60 Day", tone: styles.orange },
  { key: "30 Day", label: "30 Day", tone: styles.red },
  { key: "Expired", label: "Expired", tone: styles.red },
  { key: "Missing Information", label: "Missing Information", tone: styles.neutral },
];
const expirationChart: readonly { key: ComplianceDirectoryFilter; label: string; tone: string }[] = [
  { key: "30 Day", label: "\u226430 days", tone: styles.red },
  { key: "60 Day", label: "31\u201360 days", tone: styles.orange },
  { key: "90 Day", label: "61\u201390 days", tone: styles.yellow },
  { key: "90+", label: "90+ days", tone: styles.good },
];

export default function CompliancePage() {
  const [records, setRecords] = useState<ComplianceStatusRecord[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [complianceTypes, setComplianceTypes] = useState<ComplianceType[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ComplianceDirectoryFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchComplianceData = () => Promise.all([
    getComplianceRecords(),
    getContractors(),
    getComplianceTypes(),
  ]).then(([{ data: recordData, error: recordsError }, { data: contractorData, error: contractorsError }, { data: typeData, error: typesError }]) => {
    const loadError = recordsError || contractorsError || typesError;
    if (loadError) throw new Error(loadError.message || "Unable to load compliance records.");
    if (!recordData || !contractorData || !typeData) throw new Error("Unable to load compliance records.");
    setRecords(recordData);
    setContractors(contractorData);
    setComplianceTypes(typeData);
    setError(null);
  }).catch((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : "Unable to load compliance records.");
    setRecords([]);
  }).finally(() => {
    setLoading(false);
  });

  useEffect(() => {
    void fetchComplianceData();
  }, []);

  const filteredRecords = useMemo(() => {
    const term = search.trim().toLowerCase();

    const population = records.filter(record => matchesComplianceFilter(record, filter));
    const matchingRecords = term
      ? population.filter((record) =>
          [record.company_name, record.compliance_name, record.registration_number].some((value) =>
            (value ?? "").toLowerCase().includes(term)
          )
        )
      : population;

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
  }, [records, search, filter]);
  const count = (key: ComplianceDirectoryFilter) => records.filter(record => matchesComplianceFilter(record, key)).length;
  const unavailable = loading || error !== null;
  const summaryCards: { key: ComplianceDirectoryFilter; label: string; value: number; note: string; icon: string }[] = [
    { key: "all", label: "Total Records", value: records.length, note: "Current compliance records", icon: "Documents" },
    { key: "Expired", label: "Expired", value: count("Expired"), note: "Requires attention", icon: "Compliance" },
    { key: "30 Day", label: "Expiring \u226430 Days", value: count("30 Day"), note: "Next 30 days", icon: "Calendar" },
    { key: "31-90", label: "Expiring 31\u201390 Days", value: count("31-90"), note: "Plan upcoming renewals", icon: "Calendar" },
  ];

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

    setLoading(true);
    setError(null);
    await fetchComplianceData();
    closeModal();
    setSaving(false);
    setSuccessMessage("Compliance record added successfully.");
  };

  return (
    <main className={shared.page}>
      <div className={shared.content}>
        <div className={shared.contentHeader}>
          <div>
            <p className={shared.eyebrow}>Compliance Operations</p>
            <h1>Compliance Tracking</h1>
            <p className={shared.description}>Review current records, expiration windows and renewal priorities.</p>
          </div>
        </div>
        <Style3SummaryCards label="Compliance overview" items={summaryCards} selected={filter} onSelect={setFilter} unavailable={unavailable} />
        <div className={styles.charts}>
          {[{ title: "Compliance Status", description: "Calculated status from the authoritative compliance records.", rows: statusChart },
            { title: "Expiration Outlook", description: "Upcoming expirations only; excludes expired, missing and non-expiring records.", rows: expirationChart }].map(chart =>
            <Style3Panel key={chart.title} title={chart.title} description={chart.description}>
              {unavailable ? <p className={shared.description}>{loading ? "Loading compliance data..." : "Compliance data unavailable."}</p> :
                <div className={styles.chartRows} role="group" aria-label={`${chart.title} filters`}>
                  {chart.rows.map(row => {
                    const value = count(row.key);
                    return <button type="button" className={styles.chartButton} key={row.key} aria-pressed={filter === row.key}
                      aria-label={`${chart.title}: ${row.label}, ${value} records`} onClick={() => setFilter(row.key)}>
                      <span>{row.label}</span><span className={styles.track} aria-hidden="true">
                        <span className={`${styles.fill} ${row.tone}`} style={{ width: `${records.length ? value / records.length * 100 : 0}%` }} />
                      </span><strong>{value.toLocaleString()}</strong>
                    </button>;
                  })}
                </div>}
            </Style3Panel>)}
        </div>
        <section className={shared.surface} aria-labelledby="compliance-directory-heading">
          <div className={styles.directoryHeader}>
            <div><h2 id="compliance-directory-heading" className={shared.heading}>Compliance Directory</h2>
              <p className={shared.description}>Active contractor records. Select a summary or chart to filter.</p></div>
            <label className={styles.searchControl}><span className="sr-only">Search compliance records</span>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search compliance records" className={styles.search} />
            </label>
          </div>
          <div className={styles.filterBar}>
            <span aria-live="polite">{complianceFilterLabels[filter]}{!unavailable ? ` \u00b7 ${filteredRecords.length.toLocaleString()} of ${records.length.toLocaleString()} records` : ""}</span>
            {filter !== "all" || search ? <button type="button" className={styles.compactButton} onClick={() => { setFilter("all"); setSearch(""); }}>Clear filters</button> : null}
          </div>

          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {loading ? <div role="status" className={shared.empty}>Loading compliance records...</div> : error ? <div role="alert" className={`${shared.empty} ${shared.error}`}>{error}</div> : filteredRecords.length === 0 ? <div className={shared.empty}>No compliance records found.</div> : (
            <div className={styles.tableScroll}><table className={`${shared.operationalTable} ${styles.table}`} aria-label="Compliance directory"><thead><tr>
              {["Contractor Name", "Compliance Type", "Registration Number", "Effective Date", "Expiration Date", "Days Remaining", "Calculated Status"].map(heading =>
                <th scope="col" key={heading} className={heading === "Days Remaining" ? styles.numeric : undefined}>{heading}</th>)}
            </tr></thead><tbody>{filteredRecords.map(record => <tr key={record.compliance_record_id}>
              <td>{record.company_name}</td><td>{record.compliance_name}</td><td>{record.registration_number || "\u2014"}</td>
              <td className={styles.nowrap}>{record.effective_date || "\u2014"}</td><td className={styles.nowrap}>{record.expiration_date || "\u2014"}</td>
              <td className={styles.numeric}>{record.days_remaining ?? "\u2014"}</td><td><span className={`${shared.badge} ${statusStyles[record.calculated_status]}`}>
                {complianceFilterLabels[record.calculated_status]}</span></td>
            </tr>)}</tbody></table></div>
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
