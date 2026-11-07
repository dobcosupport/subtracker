"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { canAccessEmailCommunications, canAccessLogs, canAccessModule } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";
import type { RolePermission, UserProfile } from "@/types/user-management";
import shellStyles from "./style3/shell.module.css";
import Style3Icon from "./style3/Style3Icon";

const workspaceItems = [
  { label: "Dashboard", href: "/", module: "dashboard" },
  { label: "Contractors", href: "/contractors", module: "contractors" },
  { label: "Projects", href: "/projects", module: "projects" },
  { label: "Documents", href: "/documents", module: "documents" },
  { label: "Compliance", href: "/compliance", module: "compliance" },
  { label: "Follow-Ups", href: "/followups", module: "followups" },
  { label: "Email Communications", href: "/email-communications", module: "communications_summary" },
  { label: "Reports", href: "/reports", module: "reports" },
] as const;

const administrationItems = [
  { label: "User Management", href: "/admin/users", module: "users" },
  { label: "Roles & Permissions", href: "/admin/roles", module: "roles" },
  { label: "Company Merge", href: "/admin/company-merge", module: "company_merge" },
  { label: "Import / Export", href: "/imports", module: "imports" },
  { label: "Logs", href: "/admin/audit", module: "audit" },
  { label: "Compliance Sync", href: "/admin/compliance-sync", module: "compliance_sync" },
  { label: "Settings", href: "/settings", module: "settings" },
] as const;

type SidebarModule = (typeof workspaceItems)[number]["module"] | (typeof administrationItems)[number]["module"];
type SidebarItem = { label: string; href: string; module: SidebarModule };

export default function AppSidebar({ profile, permissions, style3 = false, open = false, onNavigate }: {
  profile: UserProfile; permissions: RolePermission[]; style3?: boolean; open?: boolean; onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [logoError, setLogoError] = useState(false);
  const visibleWorkspaceItems = workspaceItems.filter((item) => item.href === "/email-communications"
    ? canAccessEmailCommunications(permissions)
    : item.module === "followups"
    ? canAccessModule(permissions, "followups") && canAccessModule(permissions, "contractors")
    : canAccessModule(permissions, item.module));
  const visibleAdministrationItems = administrationItems.filter((item) => item.module === "audit"
    ? canAccessLogs(permissions) : canAccessModule(permissions, item.module));

  const renderItem = (item: SidebarItem) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
      || (item.href === "/admin/audit" && pathname.startsWith("/activity-log"));
    return (
      <Link
        key={item.label}
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={style3 ? `${shellStyles.navItem} ${active ? shellStyles.navActive : ""}` : `mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${
          active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <span className="flex items-center gap-3">
          <span className={style3 ? shellStyles.navIcon : `flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-semibold ${active ? "bg-white text-indigo-600" : "bg-slate-100 text-slate-500"}`}>
            {style3 ? <Style3Icon name={item.label} /> : item.label.slice(0, 1)}
          </span>
          {item.label}
        </span>
        {active && !style3 ? <span className="h-2 w-2 rounded-full bg-indigo-500" /> : null}
      </Link>
    );
  };

  return (
    <aside id="app-navigation" className={style3 ? `${shellStyles.sidebar} ${open ? shellStyles.sidebarOpen : shellStyles.sidebarClosed}` : "fixed left-0 top-0 z-40 flex h-full w-72 flex-col border-r border-slate-200 bg-white"}>
      <div className={style3 ? shellStyles.logoArea : "flex flex-col items-center border-b border-slate-200 px-6 py-6 text-center"}>
        {logoError ? <div className="flex h-20 max-w-[180px] items-center justify-center text-xs text-slate-500">LOGO NOT FOUND</div> : <Image src="/Logo.png" alt="Dobco" width={180} height={100} loading="eager" onError={() => setLogoError(true)} className={style3 ? shellStyles.logo : "h-auto max-h-20 w-auto max-w-[180px] object-contain"} />}
        <div className={style3 ? shellStyles.brandBlock : "mt-3"}>
          {style3 ? <><div className={shellStyles.brand}>Sub<span>Tracker</span></div>
            <div className={shellStyles.tagline}>COMPLIANCE &nbsp; | &nbsp; CONTRACTORS &nbsp; | &nbsp; PROJECTS</div></>
            : <><div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-400">Compliance OS</div>
              <div className="text-2xl font-semibold text-slate-900">SubTracker</div></>}
        </div>
      </div>

      <nav className={style3 ? shellStyles.navigation : "min-h-0 flex-1 overflow-y-auto px-4 py-5"}>
        {visibleWorkspaceItems.map(renderItem)}
        {visibleAdministrationItems.length > 0 ? (
          <div className={style3 ? shellStyles.adminSection : "mt-6 border-t border-slate-200 pt-4"}>
            <p className={style3 ? shellStyles.adminHeading : "mb-2 px-3 text-[10px] font-semibold uppercase text-slate-400"}>Administration</p>
            {visibleAdministrationItems.map(renderItem)}
          </div>
        ) : null}
      </nav>

      <div className={style3 ? shellStyles.account : "border-t border-slate-200 p-4"}>
        {style3 ? <div className={shellStyles.accountRow}><span className={shellStyles.avatar}>{profile.name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase()}</span>
          <div><p>{profile.name}</p><small>{profile.role}</small></div></div>
          : <><p className="truncate text-sm font-medium text-slate-800">{profile.name}</p><p className="truncate text-xs text-slate-500">{profile.role}</p></>}
        <button type="button" onClick={() => void supabase.auth.signOut()} className={style3 ? shellStyles.signOut : "mt-3 text-xs font-medium text-slate-500 hover:text-slate-900"}>{style3 ? "↪  Sign Out" : "Sign out"}</button>
      </div>
    </aside>
  );
}
