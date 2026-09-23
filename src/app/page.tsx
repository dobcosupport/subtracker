"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { label: "Dashboard", href: "/" },
  { label: "Contractors", href: "/contractors" },
  { label: "Projects", href: "/projects" },
  { label: "Compliance", href: "/compliance" },
  { label: "Activity Log", href: "/activity-log" },
  { label: "Documents", href: "/documents" },
  { label: "Imports", href: "/imports" },
  { label: "Settings", href: "/settings" },
];

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
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-[#f5f7fb] text-slate-800">
      <aside className="fixed left-0 top-0 h-full w-72 border-r border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-cyan-500 text-base font-bold text-white shadow-sm">
            S
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-400">
              Compliance OS
            </div>
            <div className="text-2xl font-semibold tracking-tight text-slate-900">
              SubTracker
            </div>
          </div>
        </div>

        <nav className="px-4 py-6">
          {navItems.map((item, index) => {
            const active = pathname === item.href;

            return (
              <Link
                key={item.label}
                href={item.href}
                className={`mb-2 flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-sm font-medium transition-all ${
                  active
                    ? "bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-semibold ${
                      active ? "bg-white text-indigo-600" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {item.label.slice(0, 1)}
                  </span>
                  {item.label}
                </span>
                {active ? <span className="h-2 w-2 rounded-full bg-indigo-500" /> : null}
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="ml-72 min-h-screen p-7">
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
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
