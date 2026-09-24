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

export default function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-40 h-full w-72 border-r border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-6">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-cyan-500 text-base font-bold text-white shadow-sm">
          S
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-400">
            Compliance OS
          </div>
          <div className="text-2xl font-semibold tracking-tight text-slate-900">SubTracker</div>
        </div>
      </div>

      <nav className="px-4 py-6">
        {navItems.map((item) => {
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
  );
}
