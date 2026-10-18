import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "activity", "view");
    const params = new URL(request.url).searchParams;
    const offset = params.get("offset") ?? "0";
    const search = (params.get("search") ?? "").trim();
    if (!/^\d{1,7}$/.test(offset) || search.length > 200) throw new AdminApiError("Invalid contractor search.", 400);
    let query = admin.from("contractors").select("id,company_name").order("company_name").order("id");
    if (search) query = query.ilike("company_name", `%${search.replace(/[\\%_]/g, "\\$&")}%`);
    const { data, error } = await query.range(Number(offset), Number(offset) + 49);
    if (error) throw error;
    return Response.json({ contractors: data ?? [], next_offset: data?.length === 50 ? Number(offset) + 50 : null });
  } catch (error) { return jsonError(error); }
}
