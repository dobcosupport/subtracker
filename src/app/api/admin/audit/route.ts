import { jsonError, requireModulePermission } from "@/lib/server-admin";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "audit", "view");
    const { data, error } = await admin.from("administration_audit_log").select("*").order("audit_date", { ascending: false }).limit(500);
    if (error) throw error;
    return Response.json({ entries: data ?? [] });
  } catch (error) {
    return jsonError(error);
  }
}
