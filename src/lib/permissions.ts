import type { AppModule, PermissionAction, RolePermission } from "@/types/user-management";

export function canAccessModule(
  permissions: RolePermission[],
  module: AppModule,
  action: PermissionAction = "view"
): boolean {
  const permission = permissions.find((entry) => entry.module === module);
  if (!permission) return false;
  if (module === "company_merge") return action === "view" || action === "manage" ? permission.can_manage : false;
  if (module.startsWith("communications_")) {
    return permission[`can_${action}`];
  }
  return action === "manage" ? permission.can_manage : permission.can_view;
}

export function canAccessCommunications(permissions: RolePermission[]): boolean {
  return canAccessModule(permissions, "communications_summary")
    || canAccessModule(permissions, "communications_content")
    || canAccessModule(permissions, "communications_content", "add")
    || canAccessModule(permissions, "communications_content", "edit")
    || canAccessModule(permissions, "communications_delivery");
}

export function canAccessLogs(permissions: RolePermission[]): boolean {
  return canAccessModule(permissions, "audit") || canAccessCommunications(permissions);
}

export function moduleForPath(pathname: string): AppModule {
  if (pathname.startsWith("/communications")) return "communications_summary";
  if (pathname.startsWith("/admin/users")) return "users";
  if (pathname.startsWith("/admin/roles")) return "roles";
  if (pathname.startsWith("/admin/audit")) return "audit";
  if (pathname.startsWith("/admin/compliance-sync")) return "compliance_sync";
  if (pathname.startsWith("/admin/company-merge")) return "company_merge";
  if (pathname.startsWith("/contractors")) return "contractors";
  if (pathname.startsWith("/compliance")) return "compliance";
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/reports")) return "reports";
  if (pathname.startsWith("/imports")) return "imports";
  if (pathname.startsWith("/documents")) return "documents";
  if (pathname.startsWith("/activity-log")) return "activity";
  if (pathname.startsWith("/settings")) return "settings";
  return "dashboard";
}
