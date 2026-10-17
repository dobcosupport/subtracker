import { isContactUuid } from "@/lib/dobco-contacts";
import { AdminApiError, jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { readDobcoContactInput, validateDobcoUserLink } from "@/lib/server-dobco-contacts";
import { dobcoContactColumns, dobcoContactFields } from "@/types/dobco-contacts";

export async function PATCH(request: Request, route: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireModulePermission(request, "settings", "manage");
    const { id } = await route.params;
    if (!isContactUuid(id)) throw new AdminApiError("Choose an existing Dobco contact.", 400);
    const input = await readDobcoContactInput(request);
    const { data: current, error: lookupError } = await context.admin.from("dobco_contacts")
      .select(dobcoContactColumns).eq("id", id).maybeSingle();
    if (lookupError) throw lookupError;
    if (!current) throw new AdminApiError("Dobco contact not found.", 404);
    await validateDobcoUserLink(request, context, input.user_profile_id, current.user_profile_id);

    const { data: contact, error } = await context.admin.from("dobco_contacts")
      .update(input).eq("id", id).select(dobcoContactColumns).maybeSingle();
    if (error) throw error;
    if (!contact) throw new AdminApiError("Dobco contact no longer exists. Reload the list.", 404);
    await writeAdministrationAudit(
      context.admin, context.profile, "DOBCO_CONTACT_UPDATED", "dobco_contact", id, contact.contact_name,
      { changed_fields: dobcoContactFields.filter((field) => current[field] !== input[field]) }
    );
    return Response.json({ contact }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
