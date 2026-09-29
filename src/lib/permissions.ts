import type { AppModule, PermissionAction, RolePermission } from "@/types/user-management";

export function canAccessModule(
  permissions: RolePermission[],
  module: AppModule,
  action: PermissionAction = "view"
): boolean {
  const permission = permissions.find((entry) => entry.module === module);
  if (!permission) return false;
  return action === "manage" ? permission.can_manage : permission.can_view;
}

export function moduleForPath(pathname: string): AppModule {
  if (pathname.startsWith("/admin/users")) return "users";
  if (pathname.startsWith("/admin/roles")) return "roles";
  if (pathname.startsWith("/admin/audit")) return "audit";
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
