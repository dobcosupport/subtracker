import { jsonError, requireModulePermission, writeAdministrationAudit, AdminApiError } from "@/lib/server-admin";
import type { UserStatus, UserRole } from "@/types/user-management";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "users", "manage");
    const { id } = await context.params;
    const body = await request.json() as { name?: string; email?: string; role?: string; status?: string; entra_object_id?: string | null; entra_group_name?: string | null; authentication_source?: string };
    const name = body.name?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    const role = body.role as UserRole;
    const status = body.status as UserStatus;
    const authenticationSource = body.authentication_source ?? "Local";
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["Active", "Inactive", "Disabled"].includes(status) || !["Local", "Microsoft Entra ID"].includes(authenticationSource)) {
      return Response.json({ error: "Enter a valid name, email, role, and status." }, { status: 400 });
    }
    const { data: roleExists, error: roleError } = await admin.from("app_roles").select("role").eq("role", role).maybeSingle();
    if (roleError) throw roleError;
    if (!roleExists) return Response.json({ error: "Choose an existing role." }, { status: 400 });

    const { data: current, error: currentError } = await admin.from("user_profiles").select("*").eq("auth_user_id", id).maybeSingle();
    if (currentError) throw currentError;
    if (!current) throw new AdminApiError("User not found.", 404);

    if ((current.system_administrator || current.protected_user) && (role !== current.role || status !== "Active")) {
      throw new AdminApiError("The protected system administrator must remain active with the Administrator role.", 409);
    }

    const isRemovingActiveAdmin = current.role === "Administrator" && current.status === "Active" && (role !== "Administrator" || status !== "Active");
    if (isRemovingActiveAdmin) {
      const { count, error: countError } = await admin.from("user_profiles")
        .select("auth_user_id", { count: "exact", head: true })
        .eq("role", "Administrator").eq("status", "Active");
      if (countError) throw countError;
      if ((count ?? 0) <= 1) throw new AdminApiError("The last active administrator cannot be deactivated or demoted.", 409);
    }
    if (actor.auth_user_id === id && (role !== current.role || status !== current.status)) {
      throw new AdminApiError("You cannot change your own role or status.", 409);
    }

    const { error: authError } = await admin.auth.admin.updateUserById(id, {
      email,
      email_confirm: true,
      user_metadata: { name, entra_object_id: body.entra_object_id?.trim() || null, entra_group_name: body.entra_group_name?.trim() || null, authentication_source: authenticationSource },
      ban_duration: status === "Active" ? "none" : "876000h",
    });
    if (authError) throw authError;

    const { data: updated, error: updateError } = await admin.from("user_profiles")
      .update({
        name,
        email,
        role,
        status,
        entra_object_id: body.entra_object_id?.trim() || null,
        entra_group_name: body.entra_group_name?.trim() || null,
        authentication_source: authenticationSource,
        updated_at: new Date().toISOString(),
      })
      .eq("auth_user_id", id)
      .select("*")
      .single();
    if (updateError) throw updateError;

    const action = status !== current.status
      ? status === "Active" ? "User Reactivated" : status === "Inactive" ? "User Inactivated" : "USER_DEACTIVATED"
      : "USER_UPDATED";
    await writeAdministrationAudit(admin, actor, action, "user", id, `${name} (${email})`, {
      changed_fields: [
        ...(name !== current.name ? ["name"] : []),
        ...(email !== current.email ? ["email"] : []),
        ...(role !== current.role ? ["role"] : []),
        ...(status !== current.status ? ["status"] : []),
        ...(body.entra_object_id !== current.entra_object_id ? ["entra_object_id"] : []),
        ...(body.entra_group_name !== current.entra_group_name ? ["entra_group_name"] : []),
        ...(authenticationSource !== current.authentication_source ? ["authentication_source"] : []),
      ],
    });
    return Response.json({ user: updated });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { admin, actor: authActor, profile: actor } = await requireModulePermission(request, "users", "manage");
    const { id } = await context.params;
    if (authActor.id === id) throw new AdminApiError("You cannot delete your own account.", 409);

    const { data: target, error: targetError } = await admin.from("user_profiles").select("*").eq("auth_user_id", id).maybeSingle();
    if (targetError) throw targetError;
    if (!target) throw new AdminApiError("User not found.", 404);
    if (target.system_administrator || target.protected_user) {
      throw new AdminApiError("The protected system administrator cannot be deleted.", 409);
    }

    const { data: authData, error: authLookupError } = await admin.auth.admin.getUserById(id);
    if (authLookupError) throw authLookupError;
    const authUser = authData.user;
    const hasNeverLoggedIn = Boolean(authUser && !target.last_login && !authUser.last_sign_in_at);
    const isPendingInvitation = Boolean(authUser && authUser.invited_at && !authUser.email_confirmed_at && hasNeverLoggedIn);
    if (!(isPendingInvitation || hasNeverLoggedIn)) {
      throw new AdminApiError("Only pending invitations or users who have never logged in can be deleted.", 409);
    }

    if (target.role === "Administrator" && target.status === "Active") {
      const { count, error: countError } = await admin.from("user_profiles")
        .select("auth_user_id", { count: "exact", head: true })
        .eq("role", "Administrator").eq("status", "Active");
      if (countError) throw countError;
      if ((count ?? 0) <= 1) throw new AdminApiError("The last active administrator cannot be deleted.", 409);
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(id);
    if (deleteError) throw deleteError;
    await writeAdministrationAudit(admin, actor, "USER_DELETED", "user", id, `${target.name} (${target.email})`, { role: target.role, email: target.email });
    return Response.json({ message: "User deleted." });
  } catch (error) {
    return jsonError(error);
  }
}
