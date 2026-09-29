export const USER_ROLES = [
  "Administrator",
  "Compliance Manager",
  "Project Manager",
  "Read Only",
] as const;

export const APP_MODULES = [
  "dashboard",
  "contractors",
  "compliance",
  "insurance",
  "followups",
  "projects",
  "tiered_subs",
  "reports",
  "imports",
  "documents",
  "activity",
  "users",
  "roles",
  "audit",
  "settings",
] as const;

export type UserRole = string;
export type AppModule = (typeof APP_MODULES)[number];
export type PermissionAction = "view" | "add" | "edit" | "delete" | "manage";
export type UserStatus = "Active" | "Inactive";
export type AuthenticationSource = "Local" | "Microsoft Entra ID";

export interface RolePermission {
  role: UserRole;
  module: AppModule;
  can_view: boolean;
  can_manage: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface UserProfile {
  auth_user_id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  entra_object_id: string | null;
  entra_group_name: string | null;
  authentication_source: AuthenticationSource;
  system_administrator: boolean;
  protected_user: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminUser extends UserProfile {
  last_login: string | null;
}

export interface AdministrationAuditEntry {
  id: number;
  user_id: string | null;
  user_name: string;
  user_email: string;
  audit_date: string;
  action: string;
  object_type: string;
  object_id: string | null;
  object_label: string;
  details: { changed_fields?: string[] };
}
