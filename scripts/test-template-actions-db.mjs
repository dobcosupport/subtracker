import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

export async function prepareTemplateActions({ db, read, fails }) {
  await db.exec(`CREATE VIEW contractor_compliance_status AS
    SELECT r.id AS compliance_record_id,r.contractor_id,t.compliance_name,r.registration_number,
      r.expiration_date,r.expiration_date-current_date AS days_remaining,'Active'::text AS calculated_status
    FROM compliance_records r JOIN compliance_types t ON t.id=r.compliance_type_id;`);
  const migration = read("20261217_communication_template_actions.sql");
  await fails(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('communication_followup_actions') t")).rows[0].t, null);
  await db.exec(migration);
  const before = (await db.query("SELECT pg_get_functiondef('communication_template_context(uuid,jsonb)'::regprocedure) definition")).rows[0].definition;
  assert.doesNotMatch(before, /'followup'/, "Replay the actual connected template-only contract before upgrading");
  const settings = (await db.query("SELECT * FROM communication_channel_settings ORDER BY channel")).rows;
  const connections = (await db.query("SELECT * FROM microsoft_email_connection_state")).rows;
  const templates = (await db.query("SELECT * FROM communication_templates ORDER BY id")).rows;
  const upgrade = read("20261218_communication_message_followup.sql");
  await fails(upgrade.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT pg_get_functiondef('communication_template_context(uuid,jsonb)'::regprocedure) definition")).rows[0].definition, before);
  await db.exec(upgrade);
  assert.deepEqual((await db.query("SELECT * FROM communication_channel_settings ORDER BY channel")).rows, settings);
  assert.deepEqual((await db.query("SELECT * FROM microsoft_email_connection_state")).rows, connections);
  assert.deepEqual((await db.query("SELECT * FROM communication_templates ORDER BY id")).rows, templates);
}

export async function testTemplateActions({ db, actor, draftSQL, manualEmailDraft }) {
  const call = async (name, args) => (await db.query(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) v`, args)).rows[0].v;
  const get = async id => (await db.query("SELECT * FROM communication_messages WHERE id=$1", [id])).rows[0];
  const row = async id => (await db.query("SELECT * FROM communication_followup_actions WHERE message_id=$1", [id])).rows[0];
  for (const existing of (await db.query("SELECT id,revision FROM communication_messages WHERE status='Scheduled'")).rows) {
    await call("plan_communication", [actor(1), existing.id, existing.revision, "cancel", null]);
  }
  const defaults = (await db.query("SELECT * FROM communication_templates")).rows;
  assert.ok(defaults.every(t => !t.followup_enabled && t.purpose === ""), "All existing templates default OFF without data activation");
  const template = { name: "Arbitrary 45-Day Fixture", category: "Expiration Reminder", channel: "email",
    subject: "Notice {{compliance_type}} — {{contractor_name}}",
    body: "{{contractor_name}}\n{{compliance_type}}\n{{registration_number}}\n{{expiration_date}}",
    is_active: true, purpose: "45 Day or any future purpose", followup_enabled: true, followup_status: "Open",
    followup_delay_days: 30, followup_subject: "Review {{compliance_type}} renewal — {{contractor_name}}",
    followup_related_item: "originating_compliance_record" };
  await db.exec(`SELECT setval(pg_get_serial_sequence('contractor_followups','id'),(SELECT max(id) FROM contractor_followups));
    UPDATE communication_channel_settings SET enabled=true,automated_enabled=true,contractor_email_enabled=true,internal_email_enabled=true WHERE channel='email';
    UPDATE microsoft_email_connection_state SET settings_revision=(SELECT revision FROM communication_channel_settings WHERE channel='email'),
      authentication_status='Verified',delivery_status='Accepted by Graph';
    UPDATE communication_email_worker_settings SET enabled=true;
    UPDATE contractors SET company_name='ABCO Electric LLC' WHERE id=1;
    UPDATE compliance_records SET registration_number='708951',expiration_date='2028-01-14' WHERE id=1;
    UPDATE contractor_contacts SET is_active=true,receives_compliance_email=true WHERE id='${actor(101)}';`);
  const templateId = await call("save_communication_template", [actor(1), null, template]);
  const contact = (await db.query("SELECT * FROM contractor_contacts WHERE id=$1", [actor(101)])).rows[0];
  const draft = { ...manualEmailDraft, template_id: templateId, template_revision: 1, contractor_ids: [1], compliance_record_ids: [1],
    project_ids: [], mycoi_policy_ids: [], insurance_items: [], subject: template.subject, body: template.body,
    recipients: [{ recipient_type: "contractor_contact", contractor_contact_id: contact.id, dobco_contact_id: null,
      recipient_name: "Untrusted display name", email: contact.email, mobile_phone: null, recipient_role: "to" }] };
  const cache = new Map(), graph = [];
  let graphFailure = false;
  class AdminApiError extends Error { constructor(message, status = 500) { super(message); this.status = status; } }
  class MicrosoftEmailError extends Error { constructor(category) { super(category); this.category = category; } }
  const rpcNames = {
    communication_template_context: ["p_actor", "p_input"], process_communication_followup: ["p_message", "p_subject", "p_error"],
    finish_communication_email_send: ["p_actor", "p_message_id", "p_outcome"],
    claim_due_scheduled_communications: [], reserve_scheduled_communication_email: ["p_message", "p_claim", "p_settings_revision"],
    finish_scheduled_communication_email: ["p_message", "p_claim", "p_outcome"],
    defer_scheduled_communication_email: ["p_message", "p_claim", "p_reason", "p_blocked"],
    preview_requirement_notice: ["p_actor", "p_rule", "p_contractor", "p_contact", "p_project"],
  };
  const admin = {
    from(table) {
      assert.ok(["communication_messages", "communication_followup_actions", "communication_channel_settings"].includes(table));
      const filters = [], orders = [];
      let columns = "*", maximum = 100;
      const query = { select(value) { columns = value; return this; }, eq(key, value) { filters.push([key, value]); return this; },
        in(key, values) { filters.push([key, values]); return this; }, order(key) { orders.push(key); return this; },
        limit(n) { maximum = n; return this; }, async single() { return this.execute(true); }, async maybeSingle() { return this.execute(true); },
        then(resolve, reject) { return this.execute(false).then(resolve, reject); },
        async execute(single) {
          const args = [];
          const where = filters.map(([key, value]) => { args.push(value); return `${key}${Array.isArray(value) ? `=ANY($${args.length})` : `=$${args.length}`}`; });
          const result = await db.query(`SELECT ${columns} FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${orders.length ? ` ORDER BY ${orders.join(",")}` : ""} LIMIT ${maximum}`, args);
          return { data: single ? result.rows[0] ?? null : result.rows, error: null };
        } };
      return query;
    },
    async rpc(name, input) {
      assert.ok(name in rpcNames, name);
      try { return { data: await call(name, rpcNames[name].map(key => input?.[key] ?? null)), error: null }; }
      catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
    },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const output = { exports: {} }; cache.set(file, output.exports);
    const code = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { module: output, exports: output.exports, Request, Response, Buffer,
      require(name) {
        if (name === "server-only") return {};
        if (name === "@/lib/server-admin") return { AdminApiError, requireModulePermission: async () => ({ admin, profile: { auth_user_id: actor(1) } }) };
        if (name === "@/lib/server-communication-compose") return { requireCompose: async () => ({ admin, profile: { auth_user_id: actor(1) } }) };
        if (name === "@/lib/server-communications") return { settingsColumns: "*", checkDatabaseError(error) {
          if (error) throw new AdminApiError(error.message, 400);
        }, communicationError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }) };
        if (name === "@/lib/server-email-provider") return { MicrosoftEmailError, microsoftIdentityStatus: () => "Ready",
          sendMicrosoftEmail: async (_settings, message) => { graph.push(message); if (graphFailure) throw new MicrosoftEmailError("graph_rejected"); } };
        if (name.startsWith("@/lib/")) return load(`src/lib/${name.slice(6)}.ts`);
        if (name.startsWith("@/types/")) return load(`types/${name.slice(8)}.ts`);
        assert.fail(name);
      },
    }, { filename: file });
    return output.exports;
  }
  const render = load("src/lib/server-template-rendering.ts");
  const actions = load("src/lib/server-communication-followup.ts");
  const delivery = load("src/lib/server-communication-email-delivery.ts");
  const worker = load("src/lib/server-scheduled-email.ts");
  const context = { admin, profile: { auth_user_id: actor(1) } };
  const resolved = await render.resolveTemplateContext(context, draft);
  const oldContractAdmin = { ...admin, rpc: async () => ({ data: { values: resolved.values, template: resolved.template }, error: null }) };
  await assert.rejects(render.resolveTemplateContext({ ...context, admin: oldContractAdmin }, { ...draft,
    followup: { enabled: true, status: "Open", timing: "relative", delay_days: 30, date: null, subject: "Reviewed choice" } }),
  /connected database requires the per-message Follow-Up migration/, "Old resolver cannot silently turn a message ON choice into template OFF");
  assert.equal(resolved.values.contact_name, contact.contact_name, "Contact name comes from the authoritative record, never the client");
  assert.equal(resolved.values.contact_first_name, null, "Full names are never split");
  const rendered = render.renderTemplateContent(draft.subject, draft.body, resolved);
  assert.equal(rendered.subject, "Notice NJ PWC — ABCO Electric LLC");
  assert.equal(rendered.body, "ABCO Electric LLC\nNJ PWC\n708951\n2028-01-14");
  assert.ok(!JSON.stringify(rendered).includes("{{"));
  await assert.rejects(render.resolveTemplateContext(context, { ...draft, contractor_ids: [2] }), /owns the exact compliance/);
  const contractorContext = await render.resolveTemplateContext(context, { ...draft, compliance_record_ids: [] });
  assert.equal(contractorContext.values.contractor_name, "ABCO Electric LLC");
  assert.equal(contractorContext.values.compliance_type, undefined, "A contractor-only Follow-Up never fabricates a compliance record");
  assert.throws(() => render.renderTemplateContent("{{contact_first_name}}", draft.body, resolved), /Contact First Name/);
  await db.exec("ALTER TABLE contractor_contacts ADD COLUMN first_name text");
  await db.query("UPDATE contractor_contacts SET first_name='Authoritative Given Name' WHERE id=$1", [contact.id]);
  assert.equal(render.renderTemplateContent("{{contact_first_name}}", "", await render.resolveTemplateContext(context, draft)).subject, "Authoritative Given Name");
  await db.exec("ALTER TABLE contractor_contacts DROP COLUMN first_name");
  const alternate = (await db.query(`INSERT INTO compliance_records(id,contractor_id,compliance_type_id,registration_number,expiration_date,active,is_current)
    VALUES((SELECT max(id)+1 FROM compliance_records),1,1,'OTHER-EXACT-RECORD','2029-03-04',false,false) RETURNING id`)).rows[0].id;
  const alternateContext = await render.resolveTemplateContext(context, { ...draft, compliance_record_ids: [alternate] });
  assert.equal(render.renderTemplateContent("{{registration_number}} {{expiration_date}}", "", alternateContext).subject, "OTHER-EXACT-RECORD 2029-03-04", "Exact selected record wins, not an arbitrary record for the company");
  for (const token of ["[Company Name]", "[Compliance Type]", "[Registration Number]", "[Expiration Date]", "{{unknown}}", "{{"]) {
    assert.throws(() => render.renderTemplateContent(token, draft.body, resolved), /Cannot send/);
    assert.throws(() => render.renderTemplateContent(draft.subject, token, resolved), /Cannot send/);
  }
  const save = async (changes = {}) => (await db.query(draftSQL(1, { ...draft, subject: rendered.subject, body: rendered.body,
    recipients: [{ ...draft.recipients[0], recipient_name: contact.contact_name, mobile_phone: contact.mobile_phone }], ...changes }))).rows[0].id;
  const settings = () => db.query("SELECT * FROM communication_channel_settings WHERE channel='email'").then(r => r.rows[0]);
  const reserve = async id => call("reserve_reviewed_communication_email_send", [actor(1), id, (await settings()).revision, (await get(id)).revision]);
  const send = async id => {
    await render.validateSavedTemplateContent(admin, id);
    const reserved = await reserve(id);
    const outcome = await delivery.deliverReservedEmail(await settings(), reserved, id,
      outcome => call("finish_communication_email_send", [actor(1), id, outcome]));
    if (outcome === "accepted") await actions.processCommunicationFollowup(admin, id);
    return outcome;
  };
  const followupChoice = { enabled: true, status: "Open", timing: "relative", delay_days: 30, date: null,
    subject: "Review {{contractor_name}}" };
  const manual = { template_id: null, template_revision: undefined, subject: "Manual email", body: "No template required",
    compliance_record_ids: [] };
  const manualOff = await save({ ...manual, followup: { ...followupChoice, enabled: false } });
  await send(manualOff);
  assert.equal((await get(manualOff)).status, "Sent");
  assert.equal(await row(manualOff), undefined, "No template + OFF sends without a Follow-Up");
  const manualOn = await save({ ...manual, followup: followupChoice });
  assert.equal((await get(manualOn)).context_snapshot.template_render.template, null);
  assert.equal(await row(manualOn), undefined, "A non-template Draft creates no Follow-Up");
  await send(manualOn);
  const manualFollowup = (await db.query("SELECT * FROM contractor_followups WHERE origin_communication_id=$1", [manualOn])).rows[0];
  assert.equal(manualFollowup.contractor_id, 1);
  assert.equal(manualFollowup.compliance_record_id, null);
  assert.equal(manualFollowup.subject, "Review ABCO Electric LLC", "Message Follow-Up subjects use the same authoritative renderer without a template");
  const manualGraphCount = graph.length;
  await Promise.all([actions.processCommunicationFollowup(admin, manualOn), actions.processCommunicationFollowup(admin, manualOn)]);
  await assert.rejects(send(manualOn), /Only an unsent manual Email/);
  assert.equal(graph.length, manualGraphCount);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractor_followups WHERE origin_communication_id=$1", [manualOn])).rows[0].n, 1);
  const uncheckedDefaultOn = await save({ followup: { ...followupChoice, enabled: false } });
  const uncheckedDraft = await get(uncheckedDefaultOn);
  const editedChoice = { ...draft, subject: rendered.subject, body: rendered.body,
    recipients: [{ ...draft.recipients[0], recipient_name: contact.contact_name, mobile_phone: contact.mobile_phone }],
    revision: uncheckedDraft.revision, followup: { ...followupChoice, enabled: false, delay_days: 19, subject: "User-edited Draft choice" } };
  await call("save_communication_draft", [actor(1), uncheckedDefaultOn, editedChoice]);
  assert.equal((await get(uncheckedDefaultOn)).context_snapshot.template_render.followup.delay_days, 19, "Draft edits preserve the message-level choice");
  await send(uncheckedDefaultOn);
  assert.equal(await row(uncheckedDefaultOn), undefined, "Template default ON + user OFF creates no Follow-Up");
  const defaultOffId = await call("save_communication_template", [actor(1), null, { ...template, name: "Ordinary default OFF", followup_enabled: false }]);
  const checkedDefaultOff = await save({ template_id: defaultOffId, followup: { ...followupChoice, delay_days: 12, status: "Waiting Response" } });
  await send(checkedDefaultOff);
  assert.equal((await row(checkedDefaultOff)).state, "completed", "Template default OFF + user ON creates one Follow-Up");
  assert.equal((await db.query("SELECT status FROM contractor_followups WHERE origin_communication_id=$1", [checkedDefaultOff])).rows[0].status, "Waiting Response");
  const selectedProject = (await db.query("SELECT id FROM projects ORDER BY id LIMIT 1")).rows[0].id;
  const fixedDate = await save({ ...manual, project_ids: [selectedProject],
    followup: { ...followupChoice, timing: "specific_date", date: "2030-04-15" } });
  await send(fixedDate);
  const fixedFollowup = (await db.query("SELECT followup_date::text,notes FROM contractor_followups WHERE origin_communication_id=$1", [fixedDate])).rows[0];
  assert.equal(fixedFollowup.followup_date, "2030-04-15", "Specific dates remain fixed and create only after acceptance");
  assert.match(fixedFollowup.notes, new RegExp(fixedDate));
  assert.deepEqual((await row(fixedDate)).snapshot.project_ids, [selectedProject], "Existing communication linkage preserves Project context without inventing a Follow-Up Project FK");
  await assert.rejects(save({ ...manual, contractor_ids: [], recipients: [{ ...manualEmailDraft.recipients[0] }],
    project_ids: [selectedProject], followup: followupChoice }), /Follow-Up requires one authoritative contractor/);
  await assert.rejects(save({ ...manual, followup: { ...followupChoice, timing: "specific_date", date: "2030-02-30" } }), /date/);
  await db.exec(`UPDATE requirement_notification_rules SET automatic_enabled=true,schedule_type='expiration',eligibility_authority='current_requirement' WHERE compliance_type_id=1;
    UPDATE requirement_notification_intervals SET enabled=false WHERE rule_id IN(SELECT id FROM requirement_notification_rules WHERE compliance_type_id=1);
    INSERT INTO communication_template_automation_approvals(template_id,template_revision,approved_by) VALUES('${templateId}',1,'${actor(1)}');
    INSERT INTO requirement_notification_intervals(rule_id,days_before_expiration,enabled,template_id)
      SELECT id,(SELECT expiration_date-current_date FROM compliance_records WHERE id=1),true,'${templateId}'
      FROM requirement_notification_rules WHERE compliance_type_id=1
      ON CONFLICT(rule_id,days_before_expiration) DO UPDATE SET enabled=true,template_id=excluded.template_id;`);
  const rule = (await db.query("SELECT id FROM requirement_notification_rules WHERE compliance_type_id=1")).rows[0].id;
  const noticeRoute = load("src/app/api/admin/notifications/requirements/preview/route.ts");
  const noticeResponse = await noticeRoute.POST(new Request("https://fixture.invalid/preview", { method: "POST",
    body: JSON.stringify({ rule_id: rule, contractor_id: 1, contact_id: contact.id }) }));
  const notice = await noticeResponse.json();
  assert.equal(noticeResponse.status, 200, JSON.stringify(notice));
  assert.equal(notice.preview.subject, rendered.subject, "Manual and requirement-notice paths share rendering");
  assert.equal(notice.preview.body, rendered.body, "Requirement notices resolve registration from the exact selected record too");
  const noticeId = await call("create_requirement_notice_draft", [actor(1), rule, 1, contact.id, null,
    notice.preview.snapshot, notice.preview.subject, notice.preview.body, false]);
  await send(noticeId);
  assert.equal((await row(noticeId)).state, "completed", "Approved notice delivery uses the same optional Follow-Up path");
  const first = await save();
  assert.equal(await row(first), undefined, "Drafting and template activation never create an action");
  await send(first);
  assert.equal((await get(first)).status, "Sent");
  assert.equal((await row(first)).state, "completed");
  const followup = (await db.query("SELECT * FROM contractor_followups WHERE origin_communication_id=$1", [first])).rows[0];
  assert.equal(followup.contractor_id, 1); assert.equal(followup.compliance_record_id, 1); assert.equal(followup.status, "Open");
  assert.equal(followup.subject, "Review NJ PWC renewal — ABCO Electric LLC");
  assert.equal((await db.query("SELECT count(*)::int n FROM communication_followups WHERE message_id=$1 AND followup_id=$2", [first, followup.id])).rows[0].n, 1, "Uses the existing communication/Follow-Up relationship");
  assert.equal((await db.query(`SELECT followup_date=(($1::timestamptz AT TIME ZONE 'America/New_York')::date+30) correct
    FROM contractor_followups WHERE id=$2`, [(await get(first)).sent_at, followup.id])).rows[0].correct, true);
  const graphAfterFirst = graph.length;
  await actions.processCommunicationFollowup(admin, first);
  await assert.rejects(send(first), /Only an unsent manual Email/);
  assert.equal(graph.length, graphAfterFirst, "Same communication cannot dispatch again");
  assert.equal((await db.query("SELECT count(*)::int n FROM contractor_followups WHERE origin_communication_id=$1", [first])).rows[0].n, 1);
  const legacy = await save();
  await db.query(`UPDATE communication_messages SET context_snapshot=jsonb_set(context_snapshot,'{template_render}',
    (context_snapshot->'template_render')-'followup') WHERE id=$1`, [legacy]);
  await send(legacy);
  assert.equal((await row(legacy)).state, "completed", "Pre-upgrade template-only snapshots remain recoverable without rewriting them");
  assert.equal((await db.query("SELECT subject FROM contractor_followups WHERE origin_communication_id=$1", [legacy])).rows[0].subject,
    "Review NJ PWC renewal — ABCO Electric LLC");
  const failed = await save();
  graphFailure = true; await send(failed); graphFailure = false;
  assert.equal((await get(failed)).status, "Failed"); assert.equal(await row(failed), undefined);
  const recovery = await save();
  await db.exec(`CREATE FUNCTION fixture_fail_followup() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    IF NEW.origin_communication_id IS NOT NULL THEN RAISE EXCEPTION 'Isolated Follow-Up write failure'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER fixture_fail_followup BEFORE INSERT ON contractor_followups FOR EACH ROW EXECUTE FUNCTION fixture_fail_followup();`);
  await send(recovery);
  assert.equal((await get(recovery)).status, "Sent", "Follow-Up failure never rolls back Graph acceptance");
  assert.equal((await row(recovery)).state, "recoverable");
  assert.match((await row(recovery)).last_error, /Isolated Follow-Up write failure/);
  const callsBeforeRecovery = graph.length;
  await db.exec("DROP TRIGGER fixture_fail_followup ON contractor_followups; DROP FUNCTION fixture_fail_followup()");
  await Promise.all([actions.processCommunicationFollowup(admin, recovery), actions.processCommunicationFollowup(admin, recovery)]);
  assert.equal((await row(recovery)).state, "completed"); assert.equal(graph.length, callsBeforeRecovery);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractor_followups WHERE origin_communication_id=$1", [recovery])).rows[0].n, 1);
  const scheduled = await save({ followup: { ...followupChoice, delay_days: 11, status: "Waiting Response" } });
  const snapshot = (await get(scheduled)).context_snapshot;
  await call("plan_communication", [actor(1), scheduled, 1, "schedule", new Date(Date.now() + 86400000).toISOString()]);
  const scheduledOff = await save({ followup: { ...followupChoice, enabled: false } });
  await call("plan_communication", [actor(1), scheduledOff, 1, "schedule", new Date(Date.now() + 86400000).toISOString()]);
  assert.equal(await row(scheduled), undefined, "Scheduling creates no Follow-Up");
  await call("save_communication_template", [actor(1), templateId, { ...template, revision: 1, name: "Renamed without special code",
    purpose: "Future custom stage", followup_delay_days: 7, followup_status: "Waiting Response", followup_subject: "Changed subject" }]);
  assert.deepEqual((await get(scheduled)).context_snapshot, snapshot, "Editing a template cannot rewrite scheduled settings");
  await db.exec(`CREATE OR REPLACE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$
    SELECT '${new Date(Date.now() + 172800000).toISOString()}'::timestamptz $$`);
  const beforeScheduled = graph.length;
  await worker.processScheduledEmail(admin);
  await worker.processScheduledEmail(admin);
  assert.equal((await get(scheduled)).status, "Sent");
  assert.equal(graph.length, beforeScheduled + 2);
  assert.equal((await get(scheduledOff)).status, "Sent");
  assert.equal(await row(scheduledOff), undefined, "Scheduled OFF overrides template ON even after template edits");
  const scheduledFollowup = (await db.query("SELECT * FROM contractor_followups WHERE origin_communication_id=$1", [scheduled])).rows[0];
  assert.equal(scheduledFollowup.status, "Waiting Response"); assert.equal(scheduledFollowup.subject, "Review ABCO Electric LLC");
  assert.equal((await db.query("SELECT snapshot->'followup'->>'delay_days' days FROM communication_followup_actions WHERE message_id=$1", [scheduled])).rows[0].days, "11");
  await worker.processScheduledEmail(admin);
  assert.equal(graph.length, beforeScheduled + 2, "Worker retries cannot duplicate a completed email");
  const revised = await save({ template_revision: 2 });
  await send(revised);
  const revisedFollowup = (await db.query("SELECT * FROM contractor_followups WHERE origin_communication_id=$1", [revised])).rows[0];
  assert.equal(revisedFollowup.status, "Waiting Response");
  assert.equal(revisedFollowup.subject, "Changed subject", "A future arbitrary-purpose template uses its configured values, never its name");
  assert.equal((await db.query(`SELECT followup_date=(($1::timestamptz AT TIME ZONE 'America/New_York')::date+7) correct
    FROM contractor_followups WHERE id=$2`, [(await get(revised)).sent_at, revisedFollowup.id])).rows[0].correct, true);
  const unresolvedId = await call("save_communication_template", [actor(1), null, { ...template, name: "Required context",
    followup_subject: "{{contact_first_name}}" }]);
  const unresolved = await save({ template_id: unresolvedId });
  await assert.rejects(render.validateSavedTemplateContent(admin, unresolved, 1), /Contact First Name/);
  const planRoute = load("src/app/api/communications/[id]/plan/route.ts");
  const blockedPlan = await planRoute.POST(new Request("https://fixture.invalid/plan", { method: "POST",
    body: JSON.stringify({ action: "schedule", revision: 1, scheduled_at: "2099-01-01T00:00:00Z" }) }), { params: Promise.resolve({ id: unresolved }) });
  assert.equal(blockedPlan.status, 400);
  assert.match((await blockedPlan.json()).error, /Contact First Name/);
  assert.equal((await get(unresolved)).status, "Draft", "A missing configured Follow-Up field blocks Schedule without mutations");
  const offId = await call("save_communication_template", [actor(1), null, { ...template, name: "No Follow-Up", followup_enabled: false }]);
  const off = await save({ template_id: offId });
  await send(off); assert.equal(await row(off), undefined, "OFF creates no Follow-Up after manual acceptance");
  const missingManualField = await save({ ...manual, followup: { ...followupChoice, subject: "{{registration_number}}" } });
  await assert.rejects(render.validateSavedTemplateContent(admin, missingManualField, 1), /Registration Number/);
  const failedManual = await save({ ...manual, followup: followupChoice });
  graphFailure = true; await send(failedManual); graphFailure = false;
  assert.equal((await get(failedManual)).status, "Failed");
  assert.equal(await row(failedManual), undefined, "No-template ON + Graph rejection creates no Follow-Up");
  for (const field of ["subject", "body"]) {
    const invalid = await save({ template_id: offId, [field]: "[Registration Number]" });
    await assert.rejects(reserve(invalid), /unresolved merge/);
    await assert.rejects(call("plan_communication", [actor(1), invalid, 1, "schedule", "2099-01-01T00:00:00Z"]), /unresolved merge/);
  }
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query("SELECT * FROM communication_followup_actions"), /permission denied/);
  await assert.rejects(call("process_communication_followup", [first, "Unauthorized", null]), /permission denied/);
  await db.exec("RESET ROLE");
  console.log("PASS: per-message Follow-Up OFF/ON without templates; template ON overridden OFF and template OFF overridden ON; authoritative exact-record/contractor context without fabricated compliance; Project context preserved via existing communication; fixed-date and relative timing; shared notice/manual rendering; unresolved fields block; acceptance creates one, rejection none; recoverable failure retains Sent; concurrent recovery/replay never duplicate email or Follow-Up; scheduled ON/OFF selections and settings survive later template edits; permissions. No real network.");
}
