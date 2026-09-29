import { getRequestContext, jsonError } from "@/lib/server-admin";

export async function GET(request: Request) {
  try {
    const { admin, actor, profile } = await getRequestContext(request);
    const { data: permissions, error: permissionError } = await admin
      .from("role_permissions")
      .select("role, module, can_view, can_manage, can_add, can_edit, can_delete")
      .eq("role", profile.role)
      .order("module");
    if (permissionError) throw permissionError;

    const lastLogin = actor.last_sign_in_at ?? profile.last_login;
    if (lastLogin && lastLogin !== profile.last_login) {
      await admin.from("user_profiles").update({ last_login: lastLogin }).eq("auth_user_id", actor.id);
    }

    return Response.json({ profile: { ...profile, last_login: lastLogin }, permissions: permissions ?? [] });
  } catch (error) {
    return jsonError(error);
  }
}
