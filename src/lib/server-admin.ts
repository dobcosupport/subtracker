import "server-only";
import { createClient, type User } from "@supabase/supabase-js";
import type { AppModule, PermissionAction, UserProfile } from "@/types/user-management";

const INACTIVITY_DAYS = 90;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function daysSince(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / DAY_IN_MILLISECONDS));
}

export function lastActivityDate(profile: UserProfile, authUser?: User | null): string | null {
  if (profile.last_login) return profile.last_login;
  if (authUser?.last_sign_in_at) return authUser.last_sign_in_at;
  if (authUser?.invited_at && !authUser.email_confirmed_at) return null;
  return authUser?.created_at ?? profile.created_at;
}

export class AdminApiError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export interface AdminContext {
  admin: ReturnType<typeof createAdminClient>;
  actor: User;
  profile: UserProfile;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new AdminApiError(`Server configuration is missing ${name}.`, 503);
  return value;
}

export function createAdminClient() {
  return createClient(
    requiredEnvironment("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
}

export function jsonError(error: unknown): Response {
  const status = error instanceof AdminApiError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return Response.json({ error: message }, { status });
}

export async function getRequestContext(request: Request): Promise<AdminContext> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new AdminApiError("Authentication is required.", 401);

  const supabaseUrl = requiredEnvironment("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requiredEnvironment("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) throw new AdminApiError("Your session is invalid or expired.", 401);

  const admin = createAdminClient();
  const { data: profile, error: profileError } = await admin
    .from("user_profiles")
    .select("auth_user_id, name, email, role, status, last_login, created_at, updated_at, entra_object_id, entra_group_name, authentication_source, system_administrator, protected_user")
    .eq("auth_user_id", authData.user.id)
    .maybeSingle();
  if (profileError) throw new AdminApiError(profileError.message, 503);
  if (!profile) throw new AdminApiError("This account has not been provisioned for SubTracker.", 403);
  if (profile.status !== "Active") throw new AdminApiError("This account is inactive.", 403);
  if (await inactivateIfInactive(admin, profile as UserProfile, profile as UserProfile, authData.user)) {
    throw new AdminApiError("Your account was inactivated after 90 days without a login.", 403);
  }

  return { admin, actor: authData.user, profile: profile as UserProfile };
}

export async function requireModulePermission(
  request: Request,
  module: AppModule,
  action: PermissionAction
): Promise<AdminContext> {
  const context = await getRequestContext(request);
  const { data: permission, error } = await context.admin
    .from("role_permissions")
    .select("can_view, can_manage, can_add, can_edit, can_delete")
    .eq("role", context.profile.role)
    .eq("module", module)
    .maybeSingle();
  if (error) throw new AdminApiError(error.message, 503);

  const allowed = action === "view"
    ? permission?.can_view
    : action === "manage"
      ? permission?.can_manage
      : permission?.[`can_${action}` as "can_add" | "can_edit" | "can_delete"];
  if (!allowed) throw new AdminApiError("You do not have permission to perform this action.", 403);
  return context;
}

export async function writeAdministrationAudit(
  admin: AdminContext["admin"],
  actor: UserProfile | null,
  action: string,
  objectType: string,
  objectId: string | null,
  objectLabel: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await admin.from("administration_audit_log").insert({
    user_id: actor?.auth_user_id ?? null,
    user_name: actor?.name ?? "Initial administrator setup",
    user_email: actor?.email ?? "",
    action,
    object_type: objectType,
    object_id: objectId,
    object_label: objectLabel,
    details,
  });
  if (error) throw new AdminApiError(error.message, 500);
}

export async function inactivateIfInactive(
  admin: ReturnType<typeof createAdminClient>,
  actor: UserProfile,
  profile: UserProfile,
  authUser?: User | null
): Promise<boolean> {
  if (profile.status !== "Active" || profile.system_administrator || profile.protected_user) return false;
  if (authUser?.invited_at && !authUser.email_confirmed_at && !authUser.last_sign_in_at) return false;

  const inactiveDays = daysSince(lastActivityDate(profile, authUser));
  if (inactiveDays === null || inactiveDays < INACTIVITY_DAYS) return false;

  if (profile.role === "Administrator") {
    const { count, error } = await admin.from("user_profiles")
      .select("auth_user_id", { count: "exact", head: true })
      .eq("role", "Administrator")
      .eq("status", "Active");
    if (error) throw error;
    if ((count ?? 0) <= 1) return false;
  }

  const { data: inactivated, error: updateError } = await admin.from("user_profiles")
    .update({ status: "Inactive", updated_at: new Date().toISOString() })
    .eq("auth_user_id", profile.auth_user_id)
    .eq("status", "Active")
    .select("auth_user_id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!inactivated) return false;

  const { error: authError } = await admin.auth.admin.updateUserById(profile.auth_user_id, { ban_duration: "876000h" });
  if (authError) throw authError;

  await writeAdministrationAudit(
    admin,
    actor,
    "User Inactivated",
    "user",
    profile.auth_user_id,
    `${profile.name} (${profile.email})`,
    { reason: "90 days without login", days_since_last_login: inactiveDays }
  );
  return true;
}

export function getLoginRedirect(): string {
  return new URL("/login", requiredEnvironment("NEXT_PUBLIC_APP_URL")).toString();
}
