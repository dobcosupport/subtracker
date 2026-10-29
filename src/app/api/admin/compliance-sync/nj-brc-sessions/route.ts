import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { njBrcBody, njBrcUserClient, positiveInteger } from "@/lib/server-nj-brc-worker";
import { safeNjBrcQueueError } from "@/lib/server-nj-brc-queue";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id");
    if (sessionId !== null) {
      if (!UUID_PATTERN.test(sessionId)) throw new AdminApiError("session_id must be a UUID.", 400);
      const { data, error } = await admin.rpc("get_nj_brc_verification_session", {
        p_session_id: sessionId,
      });
      if (error) throw error;
      if (!data) throw new AdminApiError("NJ BRC verification session not found.", 404);
      return Response.json({ session: data }, { headers: { "Cache-Control": "no-store" } });
    }

    const { data, error } = await admin.rpc("list_nj_brc_verification_sessions");
    if (error) throw error;
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeNjBrcQueueError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireModulePermission(request, "compliance_sync", "manage");
    const payload = await njBrcBody(request);
    if (Object.keys(payload).some((key) => key !== "contractor_ids")) {
      throw new AdminApiError("Only contractor_ids may be submitted.", 400);
    }
    if (!Array.isArray(payload.contractor_ids) || payload.contractor_ids.length < 1
      || payload.contractor_ids.length > 5000) {
      throw new AdminApiError("contractor_ids must contain between 1 and 5000 contractor IDs.", 400);
    }
    const contractorIds = payload.contractor_ids.map((value) => {
      const id = positiveInteger(value);
      if (!id) throw new AdminApiError("Every contractor_ids entry must be a positive integer.", 400);
      return id;
    });
    if (new Set(contractorIds).size !== contractorIds.length) {
      throw new AdminApiError("contractor_ids must not contain duplicates.", 400);
    }

    const { data, error } = await njBrcUserClient(request).rpc("create_nj_brc_verification_session", {
      p_contractor_ids: contractorIds,
    });
    if (error) throw error;
    return Response.json({
      session_id: data,
      status: "prepared",
      member_count: contractorIds.length,
    }, { status: 201 });
  } catch (error) {
    return safeNjBrcQueueError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireModulePermission(request, "compliance_sync", "manage");
    const payload = await njBrcBody(request);
    if (Object.keys(payload).some((key) => !["session_id", "action"].includes(key))) {
      throw new AdminApiError("Only session_id and action may be submitted.", 400);
    }
    if (typeof payload.session_id !== "string" || !UUID_PATTERN.test(payload.session_id)) {
      throw new AdminApiError("session_id must be a UUID.", 400);
    }
    if (!["start", "pause", "resume", "stop"].includes(String(payload.action))) {
      throw new AdminApiError("action must be start, pause, resume, or stop.", 400);
    }

    const { data, error } = await njBrcUserClient(request).rpc("set_nj_brc_verification_session_state", {
      p_session_id: payload.session_id,
      p_action: payload.action,
    });
    if (error) throw error;
    const session = Array.isArray(data) ? data[0] : data;
    return Response.json({ session });
  } catch (error) {
    return safeNjBrcQueueError(error);
  }
}
