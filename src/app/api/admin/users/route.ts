import { jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "users", "view");
    const [{ data: profiles, error: profileError }, { data: authData, error: authError }, { data: roles, error: roleError }] = await Promise.all([
      admin.from("user_profiles").select("*").order("created_at", { ascending: false }),
      admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      admin.from("app_roles").select("role").order("role"),
    ]);
    if (profileError) throw profileError;
    if (authError) throw authError;
    if (roleError) throw roleError;

    const authUsers = new Map(authData.users.map((user) => [user.id, user]));
    const users = (profiles ?? []).map((profile) => ({
      ...profile,
      last_login: profile.last_login ?? authUsers.get(profile.auth_user_id)?.last_sign_in_at ?? null,
    }));
    return Response.json({ users, roles: (roles ?? []).map((entry) => entry.role) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "users", "manage");
    const body = await request.json() as { name?: string; email?: string; role?: string; entra_object_id?: string; entra_group_name?: string; authentication_source?: string };
    const name = body.name?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    const role = body.role?.trim() ?? "";
    const authenticationSource = body.authentication_source ?? "Local";
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["Local", "Microsoft Entra ID"].includes(authenticationSource)) {
      return Response.json({ error: "Enter a valid name, email, and authentication source." }, { status: 400 });
    }
    const { data: roleExists, error: roleError } = await admin.from("app_roles").select("role").eq("role", role).maybeSingle();
    if (roleError) throw roleError;
    if (!roleExists) return Response.json({ error: "Choose an existing role." }, { status: 400 });

    const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { name, entra_object_id: body.entra_object_id?.trim() || null, entra_group_name: body.entra_group_name?.trim() || null, authentication_source: authenticationSource },
      redirectTo: new URL("/login", process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin).toString(),
    });
    if (invitationError) throw invitationError;
    if (!invitation.user) throw new Error("Supabase did not return the invited user.");

    const { data: user, error: profileError } = await admin.from("user_profiles").insert({
      auth_user_id: invitation.user.id,
      name,
      email,
      role,
      status: "Active",
      entra_object_id: body.entra_object_id?.trim() || null,
      entra_group_name: body.entra_group_name?.trim() || null,
      authentication_source: authenticationSource,
    }).select("*").single();
    if (profileError) {
      await admin.auth.admin.deleteUser(invitation.user.id);
      throw profileError;
    }

    await writeAdministrationAudit(admin, actor, "USER_CREATED", "user", user.auth_user_id, `${name} (${email})`, { role });
    return Response.json({ user }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
