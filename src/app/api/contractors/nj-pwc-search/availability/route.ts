import { jsonError, requireModulePermission } from "@/lib/server-admin";
import { getNjPwcWorkerAvailability } from "@/lib/server-worker-health";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "contractors", "manage");
    const health = await getNjPwcWorkerAvailability(admin);
    return Response.json({
      available: health.available,
      restart_required: health.restartRequired,
      message: !health.available ? "NJ PWC Worker Offline"
        : health.restartRequired ? "NJ PWC worker is running but requires a restart to load current code." : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
