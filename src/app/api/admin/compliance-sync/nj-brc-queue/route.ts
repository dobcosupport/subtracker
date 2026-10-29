import { requireModulePermission } from "@/lib/server-admin";
import { parseNjBrcQueueQuery, safeNjBrcQueueError } from "@/lib/server-nj-brc-queue";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");
    const params = parseNjBrcQueueQuery(new URL(request.url));
    const { data, error } = await admin.rpc("get_nj_brc_verification_queue", {
      p_bucket: params.bucket,
      p_search: params.search,
      p_page: params.page,
      p_page_size: params.pageSize,
    });
    if (error) throw error;

    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeNjBrcQueueError(error);
  }
}
