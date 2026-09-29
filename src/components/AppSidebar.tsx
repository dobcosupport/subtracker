"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { canAccessModule } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";
import type { RolePermission, UserProfile } from "@/types/user-management";

const workspaceItems = [
  { label: "Dashboard", href: "/", module: "dashboard" },
  { label: "Contractors", href: "/contractors", module: "contractors" },
  { label: "Projects", href: "/projects", module: "projects" },
  { label: "Reports", href: "/reports", module: "reports" },
  { label: "Activity Log", href: "/activity-log", module: "activity" },
  { label: "Documents", href: "/documents", module: "documents" },
  { label: "Imports", href: "/imports", module: "imports" },
] as const;

const administrationItems = [
  { label: "User Management", href: "/admin/users", module: "users" },
  { label: "Roles & Permissions", href: "/admin/roles", module: "roles" },
  { label: "Audit Log", href: "/admin/audit", module: "audit" },
  { label: "Settings", href: "/settings", module: "settings" },
] as const;

type SidebarModule = (typeof workspaceItems)[number]["module"] | (typeof administrationItems)[number]["module"];
type SidebarItem = { label: string; href: string; module: SidebarModule };

export default function AppSidebar({ profile, permissions }: { profile: UserProfile; permissions: RolePermission[] }) {
  const pathname = usePathname();
  const [logoError, setLogoError] = useState(false);
  const visibleWorkspaceItems = workspaceItems.filter((item) => canAccessModule(permissions, item.module));
  const visibleAdministrationItems = administrationItems.filter((item) => canAccessModule(permissions, item.module));

  const renderItem = (item: SidebarItem) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    return (
      <Link
        key={item.label}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${
          active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <span className="flex items-center gap-3">
          <span className={`flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-semibold ${active ? "bg-white text-indigo-600" : "bg-slate-100 text-slate-500"}`}>
            {item.label.slice(0, 1)}
          </span>
          {item.label}
        </span>
        {active ? <span className="h-2 w-2 rounded-full bg-indigo-500" /> : null}
      </Link>
    );
  };

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-full w-72 flex-col border-r border-slate-200 bg-white">
      <div className="flex flex-col items-center border-b border-slate-200 px-6 py-6 text-center">
        {logoError ? <div className="flex h-20 max-w-[180px] items-center justify-center text-xs text-slate-500">LOGO NOT FOUND</div> : <Image src="/Logo.png" alt="SubTracker" width={180} height={80} loading="eager" onError={() => setLogoError(true)} className="h-auto max-h-20 w-auto max-w-[180px] object-contain" />}
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-400">Compliance OS</div>
          <div className="text-2xl font-semibold text-slate-900">SubTracker</div>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {visibleWorkspaceItems.map(renderItem)}
        {visibleAdministrationItems.length > 0 ? (
          <div className="mt-6 border-t border-slate-200 pt-4">
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase text-slate-400">Administration</p>
            {visibleAdministrationItems.map(renderItem)}
          </div>
        ) : null}
      </nav>

      <div className="border-t border-slate-200 p-4">
        <p className="truncate text-sm font-medium text-slate-800">{profile.name}</p>
        <p className="truncate text-xs text-slate-500">{profile.role}</p>
        <button type="button" onClick={() => void supabase.auth.signOut()} className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-900">Sign out</button>
      </div>
    </aside>
  );
}
