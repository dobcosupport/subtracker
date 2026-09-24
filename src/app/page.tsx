/*
const stats = [
  { title: "All Companies", count: 467, color: "green" },
  { title: "90 Days", count: 21, color: "yellow" },
  { title: "60 Days", count: 12, color: "orange" },
  { title: "30 Days", count: 5, color: "red" },
  { title: "Expired", count: 8, color: "darkRed" },
  { title: "Missing Information", count: 3, color: "blue" },
];

const contractors = [
  {
    company: "Northbridge General",
    type: "Workers Comp",
    expiration: "2026-10-15",
    days: 86,
    status: "90 Days",
    projects: "North Tower",
  },
  {
    company: "Summit Roofing Co.",
    type: "Insurance",
    expiration: "2026-09-28",
    days: 58,
    status: "60 Days",
    projects: "Riverside HQ",
  },
  {
    company: "Hawthorne Utilities",
    type: "License",
    expiration: "2026-09-18",
    days: 28,
    status: "30 Days",
    projects: "West Energy Line",
  },
  {
    company: "Lakeview Concrete",
    type: "Bond",
    expiration: "2026-09-10",
    days: 0,
    status: "Expired",
    projects: "Harbor Project",
  },
  {
    company: "Blue Harbor Builders",
    type: "Certificate",
    expiration: "2026-11-15",
    days: 145,
    status: "Active",
    projects: "Harbor District",
  },
  {
    company: "Cedar Valley Group",
    type: "Safety Audit",
    expiration: "2026-10-02",
    days: 72,
    status: "90 Days",
    projects: "Cedar Crossing",
  },
];

const cardStyles = {
  green: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    pill: "bg-emerald-100 text-emerald-700",
  },
  yellow: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    pill: "bg-amber-100 text-amber-700",
  },
  orange: {
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    pill: "bg-orange-100 text-orange-700",
  },
  red: {
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
    pill: "bg-red-100 text-red-700",
  },
  darkRed: {
    bg: "bg-[#fef2f2]",
    text: "text-[#7f1d1d]",
    border: "border-[#fecaca]",
    pill: "bg-[#7f1d1d] text-white",
  },
  blue: {
    bg: "bg-sky-50",
    text: "text-sky-700",
    border: "border-sky-200",
    pill: "bg-sky-100 text-sky-700",
  },
} as const;

const statusStyles = {
  Active: "bg-emerald-100 text-emerald-700",
  "90 Days": "bg-amber-100 text-amber-700",
  "60 Days": "bg-orange-100 text-orange-700",
  "30 Days": "bg-red-100 text-red-700",
  Expired: "bg-[#7f1d1d] text-white",
} as const;

export default function Home() {
  return (
    <main className="min-h-screen p-7">
        <div className="space-y-6">
          <header className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                Overview
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
                Dashboard
              </h1>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
              >
                Export
              </button>
              <button
                type="button"
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                New Review
              </button>
            </div>
          </header>

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
            {stats.map((stat) => {
              const style = cardStyles[stat.color as keyof typeof cardStyles];

              return (
                <button
                  key={stat.title}
                  type="button"
                  className={`rounded-2xl border ${style.border} ${style.bg} p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md`}
                >
                  <div className={`text-4xl font-bold tracking-tight ${style.text}`}>
                    {stat.count}
                  </div>
                  <div className="mt-3 text-sm font-medium text-slate-700">{stat.title}</div>
                </button>
              );
            })}
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Contractor Compliance</h2>
              </div>

              <div className="relative">
                <input
                  type="text"
                  placeholder="Search contractors"
                  className="w-72 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Company Name
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Compliance Type
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Expiration Date
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Days Remaining
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Status
                    </th>
                    <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                      Assigned Projects
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {contractors.map((contractor) => (
                    <tr key={contractor.company} className="bg-white hover:bg-slate-50/80">
                      <td className="border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800">
                        {contractor.company}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.type}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.expiration}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.days}
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[contractor.status as keyof typeof statusStyles]}`}
                        >
                          {contractor.status}
                        </span>
                      </td>
                      <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">
                        {contractor.projects}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
                      <td className="border border-slate-200 px-4 py-3 text-sm font-medium">
                        <Link href={`/contractors/${record.contractor_id}`} className="text-indigo-600 hover:text-indigo-800">{record.company_name}</Link>
                      </td>
          </section>
        </div>
    </main>
  );
} */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getDashboardCompliance } from "@/services/dashboard";
import type { ComplianceStatus, ComplianceStatusRecord } from "@/types/database";

const filterOptions = ["All Companies", "90 Day", "60 Day", "30 Day", "Expired", "Missing Information"] as const;
type DashboardFilter = (typeof filterOptions)[number];

const cardStyles = {
  "All Companies": { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
  "90 Day": { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
  "60 Day": { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200" },
  "30 Day": { bg: "bg-red-50", text: "text-red-700", border: "border-red-200" },
  Expired: { bg: "bg-[#fef2f2]", text: "text-[#7f1d1d]", border: "border-[#fecaca]" },
  "Missing Information": { bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-200" },
} satisfies Record<DashboardFilter, { bg: string; text: string; border: string }>;

const statusStyles: Record<ComplianceStatus, string> = {
  Active: "bg-emerald-100 text-emerald-700",
  "90 Day": "bg-amber-100 text-amber-700",
  "60 Day": "bg-orange-100 text-orange-700",
  "30 Day": "bg-red-100 text-red-700",
  Expired: "bg-[#7f1d1d] text-white",
  "Missing Information": "bg-sky-100 text-sky-700",
};

export default function Home() {
  const [records, setRecords] = useState<ComplianceStatusRecord[]>([]);
  const [filter, setFilter] = useState<DashboardFilter>("All Companies");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadDashboard = async () => {
      setLoading(true);
      const { data, error: dashboardError } = await getDashboardCompliance();
      if (dashboardError) {
        setError(dashboardError.message || "Unable to load dashboard data.");
        setLoading(false);
        return;
      }
      setRecords(data ?? []);
      setError(null);
      setLoading(false);
    };

    void loadDashboard();
  }, []);

  const counts = useMemo(() => {
    const statusesByContractor = new Map<number, Set<ComplianceStatus>>();
    records.forEach((record) => {
      const statuses = statusesByContractor.get(record.contractor_id) ?? new Set<ComplianceStatus>();
      statuses.add(record.calculated_status);
      statusesByContractor.set(record.contractor_id, statuses);
    });

    return filterOptions.reduce<Record<DashboardFilter, number>>((result, option) => {
      result[option] = option === "All Companies"
        ? statusesByContractor.size
        : [...statusesByContractor.values()].filter((statuses) => statuses.has(option)).length;
      return result;
    }, { "All Companies": 0, "90 Day": 0, "60 Day": 0, "30 Day": 0, Expired: 0, "Missing Information": 0 });
  }, [records]);

  const visibleRecords = useMemo(() => {
    const term = search.trim().toLowerCase();
    const byContractor = new Map<number, ComplianceStatusRecord>();

    records.forEach((record) => {
      if (filter !== "All Companies" && record.calculated_status !== filter) return;
      if (!byContractor.has(record.contractor_id)) byContractor.set(record.contractor_id, record);
    });

    return [...byContractor.values()].filter((record) =>
      [record.company_name, record.compliance_name, record.registration_number].some((value) =>
        (value ?? "").toLowerCase().includes(term)
      )
    );
  }, [filter, records, search]);

  return (
    <main className="min-h-screen p-7"><div className="space-y-6">
      <header className="flex items-center justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Overview</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Dashboard</h1></div><div className="flex items-center gap-3"><button type="button" className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700">Export</button><button type="button" className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white">New Review</button></div></header>
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">{filterOptions.map((option) => { const style = cardStyles[option]; return <button key={option} type="button" onClick={() => setFilter(option)} className={`rounded-2xl border ${style.border} ${style.bg} p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${filter === option ? "ring-2 ring-indigo-400" : ""}`}><div className={`text-4xl font-bold tracking-tight ${style.text}`}>{loading ? "—" : counts[option]}</div><div className="mt-3 text-sm font-medium text-slate-700">{option}</div></button>; })}</section>
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-xl font-semibold text-slate-900">Contractor Compliance</h2><p className="mt-1 text-sm text-slate-500">Showing: {filter}</p></div><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search contractors" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm sm:w-72" /></div>{loading ? <div className="flex min-h-[220px] items-center justify-center text-sm text-slate-500">Loading dashboard data...</div> : visibleRecords.length === 0 ? <div className="flex min-h-[220px] items-center justify-center text-sm text-slate-500">No contractors found.</div> : <div className="overflow-x-auto"><table className="min-w-[900px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Company Name", "Compliance Type", "Expiration Date", "Days Remaining", "Status", "Assigned Projects"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">{heading}</th>)}</tr></thead><tbody>{visibleRecords.map((record) => <tr key={record.contractor_id} className="bg-white hover:bg-slate-50/80"><td className="border border-slate-200 px-4 py-3 text-sm font-medium"><Link href={`/contractors/${record.contractor_id}`} className="cursor-pointer text-indigo-600 underline-offset-2 hover:text-indigo-800 hover:underline">{record.company_name}</Link></td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.compliance_name || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.expiration_date || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{record.days_remaining ?? "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[record.calculated_status]}`}>{record.calculated_status}</span></td><td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">—</td></tr>)}</tbody></table></div>}</section>
    </div></main>
  );
}
