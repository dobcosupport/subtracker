import { daysSince, getRequestContext, jsonError, lastActivityDate } from "@/lib/server-admin";
import { APP_MODULES, type RolePermission } from "@/types/user-management";

// System administrators always receive full access to every module,
// regardless of the contents of role_permissions. This guarantees the
// Administrator system role can never be locked out of a module (for
// example compliance_sync) due to migration ordering or a missing row.
function fullPermissionsFor(role: string): RolePermission[] {
  return APP_MODULES.map((module) => ({
    role,
    module,
    can_view: true,
    can_manage: true,
    can_add: true,
    can_edit: true,
    can_delete: true,
  }));
}

export async function GET(request: Request) {
  try {
    const { admin, actor, profile } = await getRequestContext(request);
    const { data: permissions, error: permissionError } = await admin
      .from("role_permissions")
      .select("role, module, can_view, can_manage, can_add, can_edit, can_delete")
      .eq("role", profile.role)
      .order("module");
    if (permissionError) throw permissionError;

    const effectivePermissions = profile.system_administrator
      ? fullPermissionsFor(profile.role)
      : permissions ?? [];

    const lastLogin = actor.last_sign_in_at ?? profile.last_login;
    if (lastLogin && lastLogin !== profile.last_login) {
      await admin.from("user_profiles").update({ last_login: lastLogin }).eq("auth_user_id", actor.id);
    }

    return Response.json({
      profile: { ...profile, last_login: lastLogin, days_since_last_login: daysSince(lastActivityDate(profile, actor)) },
      permissions: effectivePermissions,
    });
  } catch (error) {
    return jsonError(error);
  }
}
