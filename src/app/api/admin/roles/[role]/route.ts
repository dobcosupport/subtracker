import { AdminApiError, jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";

type RouteContext = { params: Promise<{ role: string }> };

const SYSTEM_ROLES = new Set(["Administrator", "Compliance Manager", "Project Manager", "Read Only"]);

// The "description" column ships in a migration that may not be applied yet in every
// environment; fall back to selecting/updating without it rather than failing outright.
function isMissingDescriptionColumn(error: { message?: string } | null): boolean {
  return Boolean(error?.message?.includes("description") && error.message.includes("does not exist"));
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { admin } = await requireModulePermission(request, "roles", "view");
    const { role: encodedRole } = await context.params;
    const role = decodeURIComponent(encodedRole);

    let { data: roleEntry, error: roleError } = await admin
      .from("app_roles")
      .select("role, is_system, description, created_at")
      .eq("role", role)
      .maybeSingle();
    if (roleError && isMissingDescriptionColumn(roleError)) {
      const fallback = await admin.from("app_roles").select("role, is_system, created_at").eq("role", role).maybeSingle();
      roleEntry = fallback.data ? { ...fallback.data, description: null } : null;
      roleError = fallback.error;
    }
    if (roleError) throw roleError;
    if (!roleEntry) throw new AdminApiError("Role not found.", 404);

    const { count, error: countError } = await admin
      .from("user_profiles")
      .select("auth_user_id", { count: "exact", head: true })
      .eq("role", role);
    if (countError) throw countError;

    return Response.json({ role: roleEntry, assigned_user_count: count ?? 0 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "roles", "manage");
    const { role: encodedRole } = await context.params;
    const role = decodeURIComponent(encodedRole);
    const body = await request.json() as { newName?: string; description?: string | null };

    const { data: existing, error: existingError } = await admin.from("app_roles").select("*").eq("role", role).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw new AdminApiError("Role not found.", 404);
    if (existing.is_system) throw new AdminApiError("System roles cannot be renamed.", 409);

    const newName = body.newName?.trim().replace(/\s+/g, " ") ?? role;
    if (newName.length < 2 || newName.length > 60 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(newName)) {
      return Response.json({ error: "Role names must be 2-60 characters and contain only letters, numbers, spaces, dots, underscores, or hyphens." }, { status: 400 });
    }
    if (newName.toLowerCase() !== role.toLowerCase()) {
      const { data: collision, error: collisionError } = await admin.from("app_roles").select("role").ilike("role", newName).maybeSingle();
      if (collisionError) throw collisionError;
      if (collision) return Response.json({ error: "A role with that name already exists." }, { status: 409 });
    }

    const description = body.description?.trim() || null;
    // Renaming the primary key cascades to role_permissions.role and user_profiles.role
    // via their "ON UPDATE CASCADE" foreign keys, leaving existing permissions untouched.
    let { data: updated, error: updateError } = await admin
      .from("app_roles")
      .update({ role: newName, description })
      .eq("role", role)
      .select("role, is_system, description, created_at")
      .single();
    let descriptionApplied = true;
    if (updateError && isMissingDescriptionColumn(updateError)) {
      descriptionApplied = false;
      const fallback = await admin
        .from("app_roles")
        .update({ role: newName })
        .eq("role", role)
        .select("role, is_system, created_at")
        .single();
      updated = fallback.data ? { ...fallback.data, description: null } : null;
      updateError = fallback.error;
    }
    if (updateError) throw updateError;

    await writeAdministrationAudit(admin, actor, "ROLE_UPDATED", "role", newName, newName, {
      previous_name: role,
      renamed: newName !== role,
      description_changed: descriptionApplied && description !== (existing.description ?? null),
    });
    return Response.json({ role: updated });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "roles", "manage");
    const { role: encodedRole } = await context.params;
    const role = decodeURIComponent(encodedRole);
    const body = await request.json().catch(() => ({})) as { replacementRole?: string };

    const { data: existing, error: existingError } = await admin.from("app_roles").select("*").eq("role", role).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw new AdminApiError("Role not found.", 404);
    if (existing.is_system || SYSTEM_ROLES.has(existing.role)) {
      throw new AdminApiError("System roles cannot be deleted.", 409);
    }

    const { count, error: countError } = await admin
      .from("user_profiles")
      .select("auth_user_id", { count: "exact", head: true })
      .eq("role", role);
    if (countError) throw countError;
    const assignedUserCount = count ?? 0;

    let replacementRole: string | null = null;
    if (assignedUserCount > 0) {
      replacementRole = body.replacementRole?.trim() ?? "";
      if (!replacementRole) {
        return Response.json({ error: "This role is currently assigned to users. Choose a replacement role.", assigned_user_count: assignedUserCount }, { status: 409 });
      }
      if (replacementRole === role) {
        return Response.json({ error: "Choose a different role to reassign users to." }, { status: 400 });
      }
      const { data: replacementExists, error: replacementError } = await admin.from("app_roles").select("role").eq("role", replacementRole).maybeSingle();
      if (replacementError) throw replacementError;
      if (!replacementExists) return Response.json({ error: "The replacement role does not exist." }, { status: 400 });

      const { error: reassignError } = await admin.from("user_profiles")
        .update({ role: replacementRole, updated_at: new Date().toISOString() })
        .eq("role", role);
      if (reassignError) throw reassignError;
    }

    // role_permissions rows cascade-delete automatically via "ON DELETE CASCADE".
    const { error: deleteError } = await admin.from("app_roles").delete().eq("role", role);
    if (deleteError) throw deleteError;

    await writeAdministrationAudit(admin, actor, "ROLE_DELETED", "role", role, role, {
      reassigned_user_count: assignedUserCount,
      replacement_role: replacementRole,
    });
    return Response.json({ message: assignedUserCount > 0 ? `Reassigned ${assignedUserCount} user(s) to ${replacementRole} and deleted ${role}.` : `Deleted ${role}.` });
  } catch (error) {
    return jsonError(error);
  }
}
