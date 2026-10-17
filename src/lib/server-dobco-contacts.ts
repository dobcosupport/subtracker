import "server-only";
import { parseDobcoContact } from "@/lib/dobco-contacts";
import { AdminApiError, requireModulePermission, type AdminContext } from "@/lib/server-admin";
import type { DobcoContactInput } from "@/types/dobco-contacts";

export async function readDobcoContactInput(request: Request): Promise<DobcoContactInput> {
  try {
    return parseDobcoContact(await request.json());
  } catch (error) {
    throw new AdminApiError(error instanceof Error ? error.message : "Invalid Dobco contact data.", 400);
  }
}

export async function validateDobcoUserLink(
  request: Request,
  context: AdminContext,
  userProfileId: string | null,
  previousUserProfileId: string | null = null
): Promise<void> {
  if (!userProfileId || userProfileId === previousUserProfileId) return;
  await requireModulePermission(request, "users", "view");
  const { data, error } = await context.admin.from("user_profiles")
    .select("auth_user_id").eq("auth_user_id", userProfileId).maybeSingle();
  if (error) throw error;
  if (!data) throw new AdminApiError("The optional SubTracker user no longer exists.", 400);
}
