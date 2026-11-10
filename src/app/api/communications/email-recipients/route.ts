import { AdminApiError } from "@/lib/server-admin";
import { requireCompose } from "@/lib/server-communication-compose";
import { emailWorkspaceControls, workspacePermission } from "@/lib/server-email-workspace";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { contractorFilter } from "@/lib/server-communication-history";
import type { EmailChoice } from "@/types/email-workspace";

export async function GET(request: Request) {
  try {
    const context = await requireCompose(request);
    const { admin } = context;
    const params = new URL(request.url).searchParams;
    const search = (params.get("search") ?? "").trim();
    if (search.length > 100 || /[%_\\]/.test(search)) throw new AdminApiError("Use at most 100 characters without wildcards.", 400);
    const [contractors, internal, projects] = await Promise.all([
      workspacePermission(context, "contractors"), workspacePermission(context, "settings"), workspacePermission(context, "projects"),
    ]);
    const rows: EmailChoice[] = [];
    const pattern = JSON.stringify(`%${search}%`);
    const filter = `contact_name.ilike.${pattern},email.ilike.${pattern}`;
    const contractor = params.has("contractor_id") ? contractorFilter(params.get("contractor_id")) : null;
    const project = params.has("project_id") ? contractorFilter(params.get("project_id")) : null;
    let contractorIds: number[] | null = contractor ? [contractor] : null;
    if ((contractor || project) && !contractors) throw new AdminApiError("Contractors View permission is required.", 403);
    if (project) {
      if (!projects) throw new AdminApiError("Projects View permission is required.", 403);
      const { data, error } = await admin.from("contractor_projects").select("contractor_id").eq("project_id", project).eq("active", true).limit(101);
      checkDatabaseError(error);
      if ((data?.length ?? 0) > 100) throw new AdminApiError("This project has more than 100 assignments. Search individual contacts or companies instead.", 400);
      contractorIds = [...new Set((data ?? []).map(row => row.contractor_id))];
    }
    if (contractors && (!contractorIds || contractorIds.length)) {
      let query = admin.from("contractor_contacts")
        .select("id,contractor_id,contact_name,email,mobile_phone,contractors(company_name)")
        .order("contact_name").order("id").limit(contractorIds ? 101 : 20);
      query = contractorIds ? query.in("contractor_id", contractorIds) : query.or(filter);
      const { data, error } = await query;
      checkDatabaseError(error);
      if (contractorIds && (data?.length ?? 0) > 100) throw new AdminApiError("This selection exceeds 100 contacts. Search individual contacts instead.", 400);
      for (const c of data ?? []) {
        const company = Array.isArray(c.contractors) ? c.contractors[0] : c.contractors;
        rows.push({ key: `contractor:${c.id}`, kind: "contact", label: c.contact_name,
          detail: `Contractor Contact | ${company?.company_name ?? ""} | ${c.email ?? "No email address"}`, contractor_id: c.contractor_id,
          company_name: company?.company_name ?? `Contractor #${c.contractor_id}`,
          recipient: { recipient_type: "contractor_contact", recipient_name: c.contact_name, email: c.email,
            mobile_phone: c.mobile_phone, contractor_contact_id: c.id, dobco_contact_id: null } });
      }
    }
    if (!contractor && !project) {
      if (internal) {
        const { data, error } = await admin.from("dobco_contacts").select("id,contact_name,email,mobile_phone")
          .or(filter).order("contact_name").order("id").limit(20);
        checkDatabaseError(error);
        for (const c of data ?? []) rows.push({ key: `dobco:${c.id}`, kind: "contact", label: c.contact_name,
          detail: `Dobco Contact | ${c.email ?? "No email address"}`, recipient: {
            recipient_type: "dobco_contact", recipient_name: c.contact_name, email: c.email, mobile_phone: c.mobile_phone,
            dobco_contact_id: c.id, contractor_contact_id: null,
          } });
      }
      if (contractors && search) {
        const { data, error } = await admin.rpc("search_contractors_by_identity", { p_term: search, p_offset: 0, p_limit: 10 });
        checkDatabaseError(error);
        for (const c of data ?? []) rows.push({ key: `company:${c.id}`, kind: "company", label: c.company_name,
          detail: "Company | Choose contacts", contractor_id: c.id });
      }
      if (projects && search) {
        const { data, error } = await admin.from("projects").select("id,project_number,project_name")
          .or(`project_name.ilike.${pattern},project_number.ilike.${pattern}`).order("project_number").order("id").limit(10);
        checkDatabaseError(error);
        for (const p of data ?? []) rows.push({ key: `project:${p.id}`, kind: "project",
          label: `${p.project_number} - ${p.project_name}`, detail: "Project | Choose assigned contractor contacts", project_id: p.id });
      }
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(search)) rows.push({
        key: `external:${search.toLowerCase()}`, kind: "contact", label: search, detail: "External address | Existing email controls still apply",
        recipient: { recipient_type: "external", recipient_name: search, email: search, mobile_phone: null,
          contractor_contact_id: null, dobco_contact_id: null },
      });
    }
    const controls = await emailWorkspaceControls(context);
    const contacts = rows.filter(row => row.recipient);
    if (controls.available && contacts.length) {
      const { data, error } = await admin.rpc("communication_email_eligibility", {
        p_actor: context.profile.auth_user_id, p_recipients: contacts.map(row => row.recipient),
      });
      checkDatabaseError(error);
      if (!Array.isArray(data) || data.length !== contacts.length) throw new AdminApiError("Recipient eligibility could not be verified.", 503);
      contacts.forEach((row, i) => {
        if (data[i]?.email !== row.recipient?.email || (data[i]?.reason !== null && typeof data[i]?.reason !== "string")) {
          throw new AdminApiError("Recipient eligibility could not be verified.", 503);
        }
        row.exclusion_reason = data[i].reason;
      });
    }
    return Response.json({ rows, notice: !contractor && !project ? "Showing up to 20 contacts per source. Refine your search for more results." : null },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
