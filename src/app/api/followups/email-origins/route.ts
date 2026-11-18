import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { followupEmailOrigins } from "@/lib/server-followup-email";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "followups", "view");
    await requireModulePermission(request, "contractors", "view");
    const values = new URL(request.url).searchParams.get("ids")?.split(",") ?? [];
    if (!values.length || values.length > 200 || values.some(value => !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647)) {
      throw new AdminApiError("Choose 1–200 valid Follow-Up IDs.", 400);
    }
    return Response.json({ origins: await followupEmailOrigins(admin, [...new Set(values.map(Number))]) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
