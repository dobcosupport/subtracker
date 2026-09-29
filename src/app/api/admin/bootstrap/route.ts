import { createAdminClient, getLoginRedirect, jsonError, writeAdministrationAudit } from "@/lib/server-admin";
import { APP_MODULES, type UserProfile } from "@/types/user-management";

const SYSTEM_ADMIN = {
  name: "Rich Gulino",
  email: "richg@dobcogroup.com",
  role: "Administrator",
  status: "Active",
  authentication_source: "Local",
  system_administrator: true,
  protected_user: true,
} as const;

async function findAuthUserByEmail(admin: ReturnType<typeof createAdminClient>) {
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.toLowerCase() === SYSTEM_ADMIN.email);
    if (match) return match;
    if (data.users.length < perPage) return null;
  }
}

export async function POST(request: Request) {
  try {
    const admin = createAdminClient();
    let authUser = await findAuthUserByEmail(admin);
    let invitationSent = false;

    if (!authUser) {
      const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(SYSTEM_ADMIN.email, {
        data: {
          name: SYSTEM_ADMIN.name,
          authentication_source: SYSTEM_ADMIN.authentication_source,
          system_administrator: SYSTEM_ADMIN.system_administrator,
          protected_user: SYSTEM_ADMIN.protected_user,
        },
        redirectTo: getLoginRedirect(request),
      });
      if (invitationError) {
        authUser = await findAuthUserByEmail(admin);
        if (!authUser) throw invitationError;
      } else {
        authUser = invitation.user;
        invitationSent = true;
      }
    }
    if (!authUser) throw new Error("Supabase Auth did not return the system administrator account.");

    const existingUserMetadata = authUser.user_metadata ?? {};
    const { error: authUpdateError } = await admin.auth.admin.updateUserById(authUser.id, {
      user_metadata: {
        ...existingUserMetadata,
        name: SYSTEM_ADMIN.name,
        authentication_source: SYSTEM_ADMIN.authentication_source,
        system_administrator: SYSTEM_ADMIN.system_administrator,
        protected_user: SYSTEM_ADMIN.protected_user,
      },
      ban_duration: "none",
    });
    if (authUpdateError) throw authUpdateError;

    const { data: existingProfile, error: profileLookupError } = await admin
      .from("user_profiles")
      .select("*")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (profileLookupError) throw profileLookupError;

    if (!existingProfile) {
      const { data: profileByEmail, error: emailLookupError } = await admin
        .from("user_profiles")
        .select("auth_user_id")
        .eq("email", SYSTEM_ADMIN.email)
        .maybeSingle();
      if (emailLookupError) throw emailLookupError;
      if (profileByEmail && profileByEmail.auth_user_id !== authUser.id) {
        return Response.json({ error: "The system administrator email is already attached to another profile." }, { status: 409 });
      }
    }

    const profilePayload = {
      ...SYSTEM_ADMIN,
      auth_user_id: authUser.id,
      last_login: existingProfile?.last_login ?? authUser.last_sign_in_at ?? null,
      updated_at: new Date().toISOString(),
    };
    const { data: profile, error: profileError } = await admin
      .from("user_profiles")
      .upsert(profilePayload, { onConflict: "auth_user_id" })
      .select("*")
      .single();
    if (profileError) throw profileError;

    const fullPermissions = APP_MODULES.map((module) => ({
      role: SYSTEM_ADMIN.role,
      module,
      can_view: true,
      can_manage: true,
      can_add: true,
      can_edit: true,
      can_delete: true,
    }));
    const { error: permissionsError } = await admin
      .from("role_permissions")
      .upsert(fullPermissions, { onConflict: "role,module" });
    if (permissionsError) throw permissionsError;

    const changed = !existingProfile
      || existingProfile.role !== SYSTEM_ADMIN.role
      || existingProfile.status !== SYSTEM_ADMIN.status
      || existingProfile.system_administrator !== true
      || existingProfile.protected_user !== true
      || existingProfile.authentication_source !== SYSTEM_ADMIN.authentication_source;
    if (changed) {
      await writeAdministrationAudit(
        admin,
        profile as UserProfile,
        existingProfile ? "SYSTEM_ADMIN_PROTECTED" : "SYSTEM_ADMIN_CREATED",
        "user",
        authUser.id,
        `${SYSTEM_ADMIN.name} (${SYSTEM_ADMIN.email})`,
        { role: SYSTEM_ADMIN.role, system_administrator: true, protected_user: true }
      );
    }

    return Response.json({
      message: invitationSent
        ? `Administrator invitation sent to ${SYSTEM_ADMIN.email}.`
        : "System administrator account verified and protected.",
      invitationSent,
    }, { status: invitationSent ? 201 : 200 });
  } catch (error) {
    return jsonError(error);
  }
}
