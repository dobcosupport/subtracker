import { daysSince, getLoginRedirect, inactivateIfInactive, jsonError, lastActivityDate, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import type { AdminUser, UserProfile } from "@/types/user-management";

export async function GET(request: Request) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "users", "view");
    const [{ data: profiles, error: profileError }, { data: authData, error: authError }, { data: roles, error: roleError }] = await Promise.all([
      admin.from("user_profiles").select("*").order("created_at", { ascending: false }),
      admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      admin.from("app_roles").select("role").order("role"),
    ]);
    if (profileError) throw profileError;
    if (authError) throw authError;
    if (roleError) throw roleError;

    const authUsers = new Map(authData.users.map((user) => [user.id, user]));
    const users: AdminUser[] = [];
    for (const record of profiles ?? []) {
      const profile = record as UserProfile;
      const authUser = authUsers.get(profile.auth_user_id);
      const wasInactivated = await inactivateIfInactive(admin, actor, profile, authUser);
      const currentProfile = wasInactivated ? { ...profile, status: "Inactive" as const } : profile;
      const lastLogin = currentProfile.last_login ?? authUser?.last_sign_in_at ?? null;
      const hasNeverLoggedIn = Boolean(authUser && !currentProfile.last_login && !authUser.last_sign_in_at);
      const isPendingInvitation = Boolean(authUser
        && authUser.invited_at
        && !authUser.email_confirmed_at
        && hasNeverLoggedIn);
      const canReinvite = currentProfile.status === "Active" && (isPendingInvitation || hasNeverLoggedIn);
      const displayStatus = currentProfile.status === "Disabled"
        ? "Disabled"
        : currentProfile.status === "Inactive"
          ? "Inactive"
          : isPendingInvitation ? "Pending Invitation" : "Active";
      users.push({
        ...currentProfile,
        last_login: lastLogin,
        days_since_last_login: daysSince(lastLogin),
        last_invitation_sent: currentProfile.last_invitation_sent ?? authUser?.confirmation_sent_at ?? authUser?.invited_at ?? null,
        invitation_count: currentProfile.invitation_count ?? 0,
        display_status: displayStatus,
        can_reinvite: canReinvite,
      });
    }
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
      data: { name, role, entra_object_id: body.entra_object_id?.trim() || null, entra_group_name: body.entra_group_name?.trim() || null, authentication_source: authenticationSource },
      redirectTo: getLoginRedirect(),
    });
    if (invitationError) throw invitationError;
    if (!invitation.user) throw new Error("Supabase did not return the invited user.");

    const { data: user, error: profileError } = await admin.from("user_profiles").insert({
      auth_user_id: invitation.user.id,
      name,
      email,
      role,
      status: "Active",
      last_invitation_sent: new Date().toISOString(),
      invitation_count: 1,
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
