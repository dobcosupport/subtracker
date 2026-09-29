import "server-only";
import { createClient, type User } from "@supabase/supabase-js";
import type { AppModule, PermissionAction, UserProfile } from "@/types/user-management";

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

export function getLoginRedirect(request: Request): string {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
  return new URL("/login", siteUrl).toString();
}
