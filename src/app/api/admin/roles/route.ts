import { AdminApiError, jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { APP_MODULES, type RolePermission } from "@/types/user-management";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "roles", "view");
    const [{ data: roles, error: rolesError }, { data: permissions, error: permissionsError }] = await Promise.all([
      admin.from("app_roles").select("role, is_system, created_at").order("role"),
      admin.from("role_permissions").select("role, module, can_view, can_manage, can_add, can_edit, can_delete").order("role").order("module"),
    ]);
    if (rolesError) throw rolesError;
    if (permissionsError) throw permissionsError;
    return Response.json({ roles: roles ?? [], permissions: permissions ?? [] });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "roles", "manage");
    const body = await request.json() as { sourceRole?: string; role?: string };
    const sourceRole = body.sourceRole?.trim() ?? "";
    const role = body.role?.trim().replace(/\s+/g, " ") ?? "";
    if (role.length < 2 || role.length > 60 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(role)) {
      return Response.json({ error: "Role names must be 2-60 characters and contain only letters, numbers, spaces, dots, underscores, or hyphens." }, { status: 400 });
    }
    if (!sourceRole) return Response.json({ error: "Choose a role to clone." }, { status: 400 });

    const [{ data: existingRoles, error: existingError }, { data: sourcePermissions, error: sourceError }] = await Promise.all([
      admin.from("app_roles").select("role"),
      admin.from("role_permissions").select("module, can_view, can_manage, can_add, can_edit, can_delete").eq("role", sourceRole),
    ]);
    if (existingError) throw existingError;
    if (sourceError) throw sourceError;
    if ((existingRoles ?? []).some((entry) => entry.role.toLowerCase() === role.toLowerCase())) {
      return Response.json({ error: "A role with that name already exists." }, { status: 409 });
    }
    if (!sourcePermissions?.length) throw new AdminApiError("The selected role has no permissions to clone.", 404);

    const { error: roleError } = await admin.from("app_roles").insert({ role, is_system: false });
    if (roleError) throw roleError;
    const clonedPermissions = sourcePermissions.map((permission) => ({ ...permission, role }));
    const { error: cloneError } = await admin.from("role_permissions").insert(clonedPermissions);
    if (cloneError) {
      await admin.from("app_roles").delete().eq("role", role);
      throw cloneError;
    }

    await writeAdministrationAudit(admin, actor, "ROLE_CLONED", "role", role, role, { cloned_from: sourceRole });
    return Response.json({ role: { role, is_system: false }, permissions: clonedPermissions }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { admin, profile: actor } = await requireModulePermission(request, "roles", "manage");
    const body = await request.json() as { role?: string; permissions?: Array<Pick<RolePermission, "module" | "can_view" | "can_add" | "can_edit" | "can_delete">> };
    const role = body.role?.trim() ?? "";
    const permissions = body.permissions ?? [];
    if (!role || permissions.length !== APP_MODULES.length) {
      return Response.json({ error: "A role and permissions for every module are required." }, { status: 400 });
    }
    const modules = new Set(permissions.map((permission) => permission.module));
    const hasInvalidPermission = permissions.some((permission) =>
      !APP_MODULES.includes(permission.module)
      || [permission.can_view, permission.can_add, permission.can_edit, permission.can_delete].some((value) => typeof value !== "boolean")
    );
    if (hasInvalidPermission || modules.size !== APP_MODULES.length) {
      return Response.json({ error: "The permission matrix contains missing or invalid modules." }, { status: 400 });
    }
    if (role === "Administrator" && permissions.some((permission) =>
      !permission.can_view || !permission.can_add || !permission.can_edit || !permission.can_delete
    )) {
      throw new AdminApiError("Administrator must retain every permission for every module.", 409);
    }

    const { data: existingRole, error: roleError } = await admin.from("app_roles").select("role").eq("role", role).maybeSingle();
    if (roleError) throw roleError;
    if (!existingRole) throw new AdminApiError("Role not found.", 404);

    const rows = permissions.map((permission) => ({
      role,
      module: permission.module,
      can_view: permission.can_view,
      can_add: permission.can_add,
      can_edit: permission.can_edit,
      can_delete: permission.can_delete,
      can_manage: permission.can_add || permission.can_edit || permission.can_delete,
    }));
    const { error: saveError } = await admin.from("role_permissions").upsert(rows, { onConflict: "role,module" });
    if (saveError) throw saveError;

    await writeAdministrationAudit(admin, actor, "ROLE_PERMISSIONS_UPDATED", "role", role, role, {
      modules: rows.filter((permission) => permission.can_view || permission.can_manage).map((permission) => permission.module),
    });
    return Response.json({ permissions: rows });
  } catch (error) {
    return jsonError(error);
  }
}
