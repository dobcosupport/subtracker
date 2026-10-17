import { jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { readDobcoContactInput, validateDobcoUserLink } from "@/lib/server-dobco-contacts";
import { dobcoContactColumns, type DobcoContact } from "@/types/dobco-contacts";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "view");
    const contacts: DobcoContact[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin.from("dobco_contacts")
        .select(dobcoContactColumns).order("contact_name").order("id")
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      contacts.push(...data);
      if (data.length < pageSize) break;
    }
    return Response.json({ contacts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireModulePermission(request, "settings", "manage");
    const input = await readDobcoContactInput(request);
    await validateDobcoUserLink(request, context, input.user_profile_id);
    const { data: contact, error } = await context.admin.from("dobco_contacts")
      .insert(input).select(dobcoContactColumns).single();
    if (error) throw error;
    await writeAdministrationAudit(
      context.admin, context.profile, "DOBCO_CONTACT_CREATED", "dobco_contact",
      contact.id, contact.contact_name
    );
    return Response.json({ contact }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
