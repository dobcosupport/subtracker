import { createClient } from "@supabase/supabase-js";
import { getPasswordResetRedirect, jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "users", "manage");
    const { id } = await context.params;
    const { data: target, error: targetError } = await admin.from("user_profiles")
      .select("auth_user_id, name, email")
      .eq("auth_user_id", id)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target) return Response.json({ error: "User not found." }, { status: 404 });

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return Response.json({ error: "Supabase Auth is not configured." }, { status: 503 });
    const publicClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: resetError } = await publicClient.auth.resetPasswordForEmail(target.email, { redirectTo: getPasswordResetRedirect() });
    if (resetError) throw resetError;

    await writeAdministrationAudit(admin, actor, "PASSWORD_RESET_REQUESTED", "user", id, `${target.name} (${target.email})`);
    return Response.json({ message: "Password reset email sent." });
  } catch (error) {
    return jsonError(error);
  }
}
