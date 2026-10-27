import { createHash } from "node:crypto";
import { AdminApiError, jsonError } from "@/lib/server-admin";
import { companyContactsContext, companyContactsRpc } from "@/lib/server-company-contacts-import";
import { companyContactsTemplate, parseCompanyContactsWorkbook } from "@/lib/company-contacts-workbook";
import { isContactUuid } from "@/lib/dobco-contacts";

const noStore = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  try {
    const context = await companyContactsContext(request);
    const params = new URL(request.url).searchParams;
    if (params.get("template") === "1") {
      return new Response(companyContactsTemplate(), { headers: {
        ...noStore, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="Company Contacts Import Template.xlsx"',
      } });
    }
    const batch = params.get("batch");
    if (batch && !isContactUuid(batch)) throw new AdminApiError("Invalid Company Contacts import ID.", 400);
    return Response.json(await companyContactsRpc(context, batch ? "get" : "list",
      batch ? { batch_id: batch } : { offset: params.get("offset") ?? "0" }), { headers: noStore });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const context = await companyContactsContext(request, true);
    const file = (await request.formData()).get("file");
    if (!(file instanceof File) || !file.size || file.size > 3 * 1024 * 1024 || file.name.length > 250) {
      throw new AdminApiError("Choose a nonempty Company Contacts .xlsx file up to 3 MB, with filename up to 250 characters.", 400);
    }
    let parsed;
    try { parsed = parseCompanyContactsWorkbook(await file.arrayBuffer(), file.name); }
    catch (error) { throw new AdminApiError(error instanceof Error ? error.message : "Invalid Company Contacts workbook.", 400); }
    if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 4_000_000) throw new AdminApiError("Expanded contacts exceed the 4 MB review limit.", 400);
    // Content identity survives renamed files, reordered rows and display-only phone/email formatting.
    const identity = parsed.rows.map(({ original }) => [
      original.Name.trim().replace(/\s+/g, " ").toLowerCase(),
      /^[+0-9().\s-]+$/.test(original.Cell.trim()) ? original.Cell.replace(/[^0-9]/g, "") : original.Cell.trim(),
      original.Email.trim().toLowerCase(),
    ]).map((row) => JSON.stringify(row)).sort();
    const fileHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    return Response.json(await companyContactsRpc(context, "stage", {
      file_name: file.name, file_hash: fileHash, ...parsed,
    }), { headers: noStore });
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request) {
  try {
    const context = await companyContactsContext(request, true);
    let body;
    try { body = await request.json(); } catch { throw new AdminApiError("Invalid Company Contacts request JSON.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !["resolve", "apply"].includes(body.operation) || !isContactUuid(body.batch_id ?? "")
      || !Number.isSafeInteger(body.revision) || body.revision < 1
      || Object.keys(body).some((k) => !["operation", "batch_id", "revision", "row_id", "action", "contact_id", "contact_version", "values", "confirm_duplicate"].includes(k))) {
      throw new AdminApiError("Invalid Company Contacts review request.", 400);
    }
    if (body.operation === "resolve" && (!isContactUuid(body.row_id ?? "") || !["ADD", "UPDATE", "KEEP", "SKIP", "UNDO"].includes(body.action)
      || (body.contact_id !== null && body.contact_id !== undefined && !isContactUuid(body.contact_id)))) {
      throw new AdminApiError("Choose a valid source row and resolution.", 400);
    }
    const { operation, ...data } = body;
    return Response.json(await companyContactsRpc(context, operation, data), { headers: noStore });
  } catch (error) { return jsonError(error); }
}
