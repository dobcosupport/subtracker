import { jsonError, requireModulePermission } from "@/lib/server-admin";
import type { DobcoUserOption } from "@/types/dobco-contacts";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "manage");
    await requireModulePermission(request, "users", "view");
    const users: DobcoUserOption[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin.from("user_profiles")
        .select("auth_user_id,name,email").order("name").order("auth_user_id")
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      users.push(...data);
      if (data.length < pageSize) break;
    }
    return Response.json({ users }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
