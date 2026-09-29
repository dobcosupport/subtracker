import { AdminApiError, getLoginRedirect, jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "users", "manage");
    const { id } = await context.params;
    const { data: target, error: targetError } = await admin.from("user_profiles")
      .select("auth_user_id, name, email, role, status, last_login, invitation_count")
      .eq("auth_user_id", id)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target) throw new AdminApiError("User not found.", 404);
    const { data: authData, error: authError } = await admin.auth.admin.getUserById(id);
    if (authError) throw authError;
    const authUser = authData.user;
    const hasNeverLoggedIn = Boolean(authUser && !target.last_login && !authUser.last_sign_in_at);
    const isPendingInvitation = Boolean(authUser && authUser.invited_at && !authUser.email_confirmed_at && hasNeverLoggedIn);
    if (target.status !== "Active" || !(isPendingInvitation || hasNeverLoggedIn)) {
      throw new AdminApiError("Only pending invitations or users who have never logged in can be re-invited.", 409);
    }

    const { error: metadataError } = await admin.auth.admin.updateUserById(id, {
      user_metadata: { ...authUser.user_metadata, name: target.name, role: target.role },
    });
    if (metadataError) throw metadataError;

    const { error: invitationError } = await admin.auth.admin.inviteUserByEmail(target.email, { redirectTo: getLoginRedirect() });
    if (invitationError) throw invitationError;

    const invitationSentAt = new Date().toISOString();
    const { error: profileUpdateError } = await admin.from("user_profiles")
      .update({ last_invitation_sent: invitationSentAt, invitation_count: (target.invitation_count ?? 0) + 1, updated_at: invitationSentAt })
      .eq("auth_user_id", id);
    if (profileUpdateError) throw profileUpdateError;

    await writeAdministrationAudit(
      admin,
      actor,
      "Re-Invite User",
      "user",
      id,
      `${target.name} (${target.email})`,
      { invited_email: target.email }
    );
    return Response.json({ message: `Invitation sent to ${target.email}.` });
  } catch (error) {
    return jsonError(error);
  }
}
