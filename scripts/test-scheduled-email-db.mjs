import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";

export async function testScheduledEmail({ db, read, fails, actor, draftSQL, manualEmailDraft }) {
  const migration = read("20261214_scheduled_email_worker.sql");
  assert.doesNotMatch(migration, /cron\.schedule|net\.http|http_post/i);
  const before = (await db.query("SELECT * FROM communication_messages ORDER BY id")).rows;
  await fails(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('communication_email_worker_settings') t")).rows[0].t, null);
  await db.exec(migration);
  const initialClock = (await db.query("SELECT pg_catalog.clock_timestamp() at")).rows[0].at;
  await db.exec(`CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$
    SELECT '${new Date(initialClock).toISOString()}'::timestamptz $$;
    SET search_path=public,pg_catalog,pg_temp;`);
  for (const fn of (await db.query(`SELECT oid::regprocedure::text name FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND prokind='f' AND proname<>'clock_timestamp'`)).rows) {
    await db.exec(`ALTER FUNCTION ${fn.name} SET search_path=public,pg_catalog,pg_temp`);
  }
  assert.deepEqual((await db.query("SELECT * FROM communication_messages ORDER BY id")).rows, before);
  assert.equal((await db.query("SELECT enabled FROM communication_email_worker_settings")).rows[0].enabled, false);
  assert.equal((await db.query(`SELECT count(*)::int n FROM pg_indexes WHERE tablename='communication_email_schedule_state'
    AND indexname IN('communication_email_schedule_pending','communication_email_schedule_stale')`)).rows[0].n, 2);
  const q = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const call = async (name, args = []) => (await db.query(`SELECT ${name}(${args.join(",")}) v`)).rows[0].v;
  const text = value => `'${String(value).replaceAll("'", "''")}'`;
  const policy = async input => {
    const revision = (await db.query("SELECT revision FROM communication_email_worker_settings")).rows[0].revision;
    return call("save_communication_email_worker_settings", [text(actor(1)), q({ revision, ...input })]);
  };
  await fails(`SELECT save_communication_email_worker_settings('${actor(2)}','{"revision":1,"enabled":true}')`, "42501");
  await fails(`SELECT save_communication_email_worker_settings('${actor(1)}','{"revision":1,"enabled":null}')`, "22023");
  await fails(`SELECT save_communication_email_worker_settings('${actor(1)}','{"revision":1,"batch_size":0}')`, "23514");
  await fails(`SELECT save_communication_email_worker_settings('${actor(1)}','{"revision":1,"unknown":true}')`, "22023");
  await assert.rejects(policy({ enabled: true }), /Activation stopped/);
  // Existing plan-only fixtures are cancelled explicitly, never auto-enrolled.
  for (const m of (await db.query("SELECT id,revision FROM communication_messages WHERE status='Scheduled'")).rows) {
    await call("plan_communication", [text(actor(1)), text(m.id), m.revision, "'cancel'", "NULL"]);
  }
  await policy({ enabled: true, batch_size: 2, retry_delay_seconds: 30 });
  await db.exec(`UPDATE communication_channel_settings SET enabled=true,automated_enabled=true,
      contractor_email_enabled=true,internal_email_enabled=true WHERE channel='email';
    UPDATE microsoft_email_connection_state SET settings_revision=(SELECT revision FROM communication_channel_settings WHERE channel='email'),
      authentication_status='Verified',delivery_status='Accepted by Graph';
    UPDATE contractor_contacts SET is_active=true,receives_compliance_email=true;
    UPDATE dobco_contacts SET is_active=true,receives_internal_email=true;`);
  const c = (await db.query(`SELECT * FROM contractor_contacts WHERE id='${actor(101)}'`)).rows[0];
  const d = (await db.query(`SELECT * FROM dobco_contacts WHERE id='${actor(102)}'`)).rows[0];
  for (const enabled of [false, true]) {
    const s = (await db.query("SELECT * FROM communication_channel_settings WHERE channel='email'")).rows[0];
    const input = Object.fromEntries(["provider", "enabled", "automated_enabled", "from_name", "from_address", "reply_to_address",
      "microsoft_tenant_id", "microsoft_client_id", "revision"].map(key => [key, s[key]]));
    input.automated_enabled = enabled;
    await call("save_communication_settings", [text(actor(1)), "'email'", q(input)]);
    const connection = (await db.query("SELECT * FROM microsoft_email_connection_state")).rows[0];
    assert.equal(connection.settings_revision, s.revision + 1, "Automation-only changes preserve previously Verified sender identity");
    assert.equal(connection.authentication_status, "Verified");
  }
  const recipients = [
    { recipient_type: "dobco_contact", recipient_role: "to", recipient_name: d.contact_name, email: d.email,
      mobile_phone: d.mobile_phone, contractor_contact_id: null, dobco_contact_id: d.id },
    { recipient_type: "contractor_contact", recipient_role: "cc", recipient_name: c.contact_name, email: c.email,
      mobile_phone: c.mobile_phone, contractor_contact_id: c.id, dobco_contact_id: null },
    { recipient_type: "external", recipient_role: "bcc", recipient_name: "Synthetic only", email: "fixture@example.invalid",
      mobile_phone: null, contractor_contact_id: null, dobco_contact_id: null },
  ];
  const save = async (rs = recipients, changes = {}) => (await db.query(draftSQL(1, {
    ...manualEmailDraft, template_id: null, subject: "Scheduled synthetic fixture", body: "Synthetic message only",
    recipients: rs, contractor_ids: [c.contractor_id], ...changes,
  }))).rows[0].id;
  const schedule = async (rs = recipients, changes = {}) => {
    const id = await save(rs, changes);
    await call("plan_communication", [text(actor(1)), text(id), 1, "'schedule'", "clock_timestamp()+interval '1 second'"]);
    return id;
  };
  // A controlled clock, rather than sleeps or frozen-history bypasses.
  const due = async () => {
    const waits = await db.query("SELECT max(scheduled_at) at FROM communication_messages WHERE status='Scheduled'");
    const instant = new Date(new Date(waits.rows[0].at ?? Date.now()).getTime() + 2000).toISOString();
    await db.exec(`CREATE OR REPLACE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$
      SELECT '${instant}'::timestamptz $$`);
  };
  const claim = () => call("claim_due_scheduled_communications");
  const revision = () => db.query("SELECT revision FROM communication_channel_settings WHERE channel='email'").then(r => r.rows[0].revision);
  const reserve = async job => call("reserve_scheduled_communication_email", [text(job.id), text(job.claim_token), await revision()]);
  const finish = (job, outcome) => call("finish_scheduled_communication_email", [text(job.id), text(job.claim_token), text(outcome)]);
  const state = id => db.query(`SELECT m.status,s.* FROM communication_messages m JOIN communication_email_schedule_state s
    ON s.message_id=m.id WHERE m.id='${id}'`).then(r => r.rows[0]);
  const retryNow = id => db.exec(`UPDATE communication_email_schedule_state SET next_attempt_at=clock_timestamp() WHERE message_id='${id}'`);
  const manual = await save();
  const manualReservation = await call("reserve_reviewed_communication_email_send", [text(actor(1)), text(manual), await revision(), 1]);
  assert.equal(manualReservation.recipients.length, 3);
  await call("finish_communication_email_send", [text(actor(1)), text(manual), "'accepted'"]);
  const frozen = (await db.query(`SELECT status,context_snapshot FROM communication_messages WHERE id='${manual}'`)).rows[0];
  assert.equal(frozen.status, "Sent");
  await fails(`UPDATE communication_recipients SET recipient_role='bcc' WHERE message_id='${manual}'`, "23514");
  const notice = (await db.query(`SELECT n.* FROM requirement_notice_communications n
    JOIN communication_messages m ON m.id=n.message_id WHERE n.is_test LIMIT 1`)).rows[0];
  const preview = await call("preview_requirement_notice", [text(actor(1)), text(notice.rule_id), notice.contractor_id, text(notice.contact_id), "NULL"]);
  delete preview.duplicate; delete preview.other_recipient_sent;
  const noticeId = await call("create_requirement_notice_draft", [text(actor(1)), text(notice.rule_id), notice.contractor_id, text(notice.contact_id),
    "NULL", q(preview), "'[TEST] Isolated scheduled notice'", "'Synthetic only'", true]);
  await call("plan_communication", [text(actor(1)), text(noticeId), 1, "'schedule'", "clock_timestamp()+interval '1 second'"]);
  await due();
  const [noticeJob] = await claim();
  assert.equal((await reserve(noticeJob)).blocked, false);
  await finish(noticeJob, "accepted");
  assert.equal((await db.query(`SELECT outcome FROM requirement_notice_delivery_outcomes WHERE message_id='${noticeId}'`)).rows[0].outcome, "accepted");
  const future = await schedule();
  assert.deepEqual(await claim(), [], "Future waits");
  await due();
  const [job] = await claim();
  assert.equal(job.id, future);
  assert.deepEqual(await claim(), [], "Concurrent trigger cannot claim the leased message");
  const ready = await reserve(job);
  assert.equal(ready.blocked, false);
  assert.deepEqual(ready.reservation.recipients.map(r => r.recipient_role).sort(), ["bcc", "cc", "to"]);
  await assert.rejects(reserve(job), /no longer available/);
  await finish(job, "accepted");
  assert.equal((await state(future)).status, "Sent");
  await assert.rejects(finish(job, "accepted"), /no longer available/);
  assert.deepEqual(await claim(), [], "Already Sent never reclaims");

  for (const field of ["enabled", "automated_enabled", "contractor_email_enabled", "internal_email_enabled"]) {
    const id = await schedule();
    await due();
    const [lease] = await claim();
    await db.exec(`UPDATE communication_channel_settings SET ${field}=false WHERE channel='email'`);
    const blocked = await reserve(lease);
    assert.equal(blocked.blocked, true, field);
    assert.equal((await state(id)).status, "Scheduled");
    assert.ok((await state(id)).blocked_reason);
    await db.exec(`UPDATE communication_channel_settings SET ${field}=true WHERE channel='email'`);
    await retryNow(id);
    const [again] = await claim();
    assert.equal((await reserve(again)).blocked, false, "Dynamic settings take effect without code changes");
    await finish(again, "accepted");
  }
  // A disabled master must not disable the other recipient type.
  for (const [field, recipient] of [["contractor_email_enabled", recipients[0]], ["internal_email_enabled", recipients[1]]]) {
    const id = await schedule([recipient]);
    await due();
    const [lease] = await claim();
    await db.exec(`UPDATE communication_channel_settings SET ${field}=false WHERE channel='email'`);
    assert.equal((await reserve(lease)).blocked, false);
    await finish(lease, "accepted");
    await db.exec(`UPDATE communication_channel_settings SET ${field}=true WHERE channel='email'`);
    assert.equal((await state(id)).status, "Sent");
  }
  for (const [table, contact, change, undo] of [
    ["contractor_contacts", c, "receives_compliance_email=false", "receives_compliance_email=true"],
    ["dobco_contacts", d, "receives_internal_email=false", "receives_internal_email=true"],
    ["contractor_contacts", c, "is_active=false", "is_active=true"],
    ["dobco_contacts", d, "is_active=false", "is_active=true"],
    ["contractor_contacts", c, "email='changed@example.invalid'", `email='${c.email}'`],
    ["dobco_contacts", d, "email='changed@example.invalid'", `email='${d.email}'`],
  ]) {
    for (const role of ["to", "cc", "bcc"]) {
      const recipient = contact === c ? recipients[1] : recipients[0];
      const id = await schedule([{ ...recipient, recipient_role: role }]);
      await due();
      const [lease] = await claim();
      await db.exec(`UPDATE ${table} SET ${change} WHERE id='${contact.id}'`);
      assert.equal((await reserve(lease)).blocked, true, `${table} ${change} ${role}`);
      assert.equal((await state(id)).status, "Scheduled");
      await db.exec(`UPDATE ${table} SET ${undo} WHERE id='${contact.id}'`);
      await call("plan_communication", [text(actor(1)), text(id), 2, "'cancel'", "NULL"]);
    }
  }
  const lostAccess = await schedule();
  await due();
  const [lostLease] = await claim();
  await db.exec(`UPDATE user_profiles SET status='Inactive' WHERE auth_user_id='${actor(1)}'`);
  assert.equal((await reserve(lostLease)).blocked, true);
  await db.exec(`UPDATE user_profiles SET status='Active' WHERE auth_user_id='${actor(1)}'`);
  await retryNow(lostAccess);
  const [restored] = await claim();
  await reserve(restored);
  await db.exec(`UPDATE user_profiles SET status='Inactive' WHERE auth_user_id='${actor(1)}'`);
  await finish(restored, "accepted"); // Actual Graph result cannot be lost to a later permission change.
  await db.exec(`UPDATE user_profiles SET status='Active' WHERE auth_user_id='${actor(1)}'`);
  const cancelled = await schedule();
  await due();
  const [cancelLease] = await claim();
  await call("plan_communication", [text(actor(1)), text(cancelled), 2, "'cancel'", "NULL"]);
  await assert.rejects(reserve(cancelLease), /no longer available/);
  assert.equal((await state(cancelled)).status, "Cancelled");
  await assert.rejects(schedule(recipients, { body: "Unresolved {{field}}" }), /rendered/);
  const max = Array.from({ length: 100 }, (_, i) => ({ ...recipients[2], recipient_role: ["to", "cc", "bcc"][i % 3],
    email: `test${i}@example.invalid`, recipient_name: `Synthetic ${i}` }));
  const maxId = await schedule(max);
  await due();
  const [maxLease] = await claim();
  assert.equal((await reserve(maxLease)).reservation.recipients.length, 100);
  await finish(maxLease, "graph_rejected");
  assert.equal((await state(maxId)).status, "Failed");
  await assert.rejects(save([...max, { ...recipients[2], email: "extra@example.invalid" }]), /100/);
  for (const outcome of ["graph_rejected", "outcome_unknown", "authentication_failed", "identity_configuration"]) {
    const id = await schedule();
    await due();
    const [lease] = await claim();
    await reserve(lease);
    await finish(lease, outcome);
    assert.equal((await state(id)).status, "Failed");
    assert.deepEqual(await claim(), [], "No automatic provider replay even for definite failures");
  }
  const stale = await schedule();
  await due();
  const [staleLease] = await claim();
  await db.exec(`UPDATE communication_email_schedule_state SET claimed_at=clock_timestamp()-interval '1 day' WHERE message_id='${stale}'`);
  assert.deepEqual(await claim(), [], "Stale pre-dispatch claim is deferred, not sent");
  await assert.rejects(reserve(staleLease), /no longer available/);
  await retryNow(stale);
  const [recovered] = await claim();
  assert.notEqual(recovered.claim_token, staleLease.claim_token);
  await reserve(recovered);
  await db.exec(`UPDATE communication_email_schedule_state SET claimed_at=clock_timestamp()-interval '1 day' WHERE message_id='${stale}'`);
  assert.deepEqual(await claim(), []);
  assert.equal((await state(stale)).status, "Failed");
  assert.equal((await state(stale)).outcome, "outcome_unknown", "Stale dispatch is quarantined, never replayed");
  await assert.rejects(finish(recovered, "accepted"), /no longer available/);

  await policy({ retry_policy: "none" });
  const noRetry = await schedule();
  await due();
  const [noRetryLease] = await claim();
  await call("defer_scheduled_communication_email", [text(noRetry), text(noRetryLease.claim_token), "'Synthetic preflight failure'", false]);
  assert.equal((await state(noRetry)).outcome, "pre_dispatch_failed");
  await policy({ retry_policy: "pre_dispatch_only", maximum_attempts: 2, batch_size: 1 });
  const exhaust = await schedule();
  await due();
  for (let i = 0; i < 2; i++) {
    const [lease] = await claim();
    await call("defer_scheduled_communication_email", [text(exhaust), text(lease.claim_token), "'Synthetic preflight failure'", false]);
    await retryNow(exhaust);
  }
  assert.ok((await state(exhaust)).finished_at);
  assert.deepEqual(await claim(), []);
  assert.equal((await state(exhaust)).status, "Scheduled", "Pre-dispatch exhaustion stays unsent with review reason");
  const fairFirst = await schedule(), fairSecond = await schedule();
  await due();
  const [fairLease] = await claim();
  await db.exec("UPDATE communication_channel_settings SET automated_enabled=false WHERE channel='email'");
  assert.equal((await reserve(fairLease)).blocked, true);
  await retryNow(fairLease.id);
  const [fairNext] = await claim();
  assert.notEqual(fairNext.id, fairLease.id, "An old blocked message cannot starve newly eligible work, even when its delay expires");
  for (const id of [fairFirst, fairSecond]) {
    await call("plan_communication", [text(actor(1)), text(id), 2, "'cancel'", "NULL"]);
  }
  await db.exec("UPDATE communication_channel_settings SET automated_enabled=true WHERE channel='email'");

  let graphCalls = [], graphFailure = false, finishFailure = false, prepareFailure = false;
  const cache = new Map();
  const names = {
    claim_due_scheduled_communications: [],
    reserve_scheduled_communication_email: ["p_message", "p_claim", "p_settings_revision"],
    finish_scheduled_communication_email: ["p_message", "p_claim", "p_outcome"],
    defer_scheduled_communication_email: ["p_message", "p_claim", "p_reason", "p_blocked"],
    communication_scheduled_email_status: [],
  };
  const admin = {
    from(table) {
      assert.equal(table, "communication_channel_settings");
      return { select() { return this; }, eq() { return this; }, async single() {
        return { data: (await db.query("SELECT * FROM communication_channel_settings WHERE channel='email'")).rows[0], error: null };
      } };
    },
    async rpc(name, input = {}) {
      assert.ok(name in names);
      if (name === "finish_scheduled_communication_email" && finishFailure) return { error: { code: "503", message: "Synthetic recording failure" } };
      try {
        return { data: (await db.query(`SELECT ${name}(${names[name].map((_, i) => `$${i + 1}`).join(",")}) v`,
          names[name].map(key => input[key]))).rows[0].v, error: null };
      } catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
    },
  };
  class AdminApiError extends Error { constructor(message, status = 500) { super(message); this.status = status; } }
  class MicrosoftEmailError extends Error { constructor(category) { super(category); this.category = category; } }
  let serviceInvocations = 0;
  const env = {};
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const output = { exports: {} }; cache.set(file, output.exports);
    const code = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { module: output, exports: output.exports, Request, Response, Buffer, process: { env },
      require(name) {
        if (name === "server-only") return {};
        if (name === "node:crypto") return crypto;
        if (name === "@/lib/server-admin") return { AdminApiError, createAdminClient: () => admin };
        if (name === "@/lib/server-communications") return {
          settingsColumns: "synthetic-settings",
          checkDatabaseError(error) { if (error) throw new AdminApiError(error.message, 500); },
          communicationError(error) { return Response.json({ error: error.message }, { status: error.status ?? 500 }); },
        };
        if (name === "@/lib/server-email-provider") return { MicrosoftEmailError,
          microsoftIdentityStatus: () => prepareFailure ? "Unavailable" : "Ready",
          sendMicrosoftEmail: async (settings, message) => {
            graphCalls.push({ settings, message });
            if (graphFailure) throw new MicrosoftEmailError(graphFailure);
          } };
        if (name.startsWith("@/lib/")) return load(`src/lib/${name.slice(6)}.ts`);
        assert.fail(name);
      },
    }, { filename: file });
    return output.exports;
  }
  const worker = load("src/lib/server-scheduled-email.ts");
  const run = () => { serviceInvocations++; return worker.processScheduledEmail(admin); };
  const id = await schedule();
  await due();
  const concurrent = await Promise.all([run(), run()]);
  assert.equal(concurrent.reduce((n, r) => n + r.sent, 0), 1);
  assert.equal(graphCalls.length, 1, "Overlapping workers deliver exactly once");
  assert.equal((await state(id)).status, "Sent");
  assert.deepEqual(Object.keys(graphCalls[0].message).sort(), ["bccRecipients", "body", "ccRecipients", "recipients", "subject"]);
  assert.equal(graphCalls[0].message.ccRecipients[0], c.email);
  assert.equal(graphCalls[0].message.bccRecipients[0], recipients[2].email);
  await run();
  assert.equal(graphCalls.length, 1);
  const failed = await schedule();
  await due(); graphFailure = "graph_rejected";
  assert.equal((await run()).failed, 1);
  assert.equal((await state(failed)).status, "Failed");
  await run(); assert.equal(graphCalls.length, 2);
  const ambiguous = await schedule();
  await due(); graphFailure = false; finishFailure = true;
  await assert.rejects(run(), /could not be recorded/);
  assert.equal((await state(ambiguous)).status, "Sending");
  await run(); assert.equal(graphCalls.length, 3, "Recording failure cannot duplicate accepted delivery");
  finishFailure = false;
  await db.exec(`UPDATE communication_email_schedule_state SET claimed_at=clock_timestamp()-interval '1 day' WHERE message_id='${ambiguous}'`);
  await run();
  assert.equal((await state(ambiguous)).outcome, "outcome_unknown");
  const preparation = await schedule();
  await due(); prepareFailure = true;
  assert.equal((await run()).deferred, 1);
  assert.equal(graphCalls.length, 3);
  prepareFailure = false; await retryNow(preparation);
  assert.equal((await run()).sent, 1);
  assert.equal(graphCalls.length, 4, "Only a pre-dispatch failure can be retried");

  const status = load("src/lib/server-scheduled-email-status.ts");
  assert.equal((await status.scheduledEmailStatus(admin)).execution_enabled, true);
  await db.exec("UPDATE communication_channel_settings SET automated_enabled=false WHERE channel='email'");
  assert.match((await status.scheduledEmailStatus(admin)).notice, /Automatic Delivery is disabled/);
  const disabled = await schedule();
  await due();
  assert.equal((await run()).blocked, 1);
  assert.equal(graphCalls.length, 4);
  assert.equal((await state(disabled)).status, "Scheduled");
  await db.exec("UPDATE communication_channel_settings SET automated_enabled=true WHERE channel='email'");
  const trigger = load("src/app/api/cron/scheduled-email/route.ts");
  const request = secret => new Request("https://synthetic.invalid/api/cron/scheduled-email", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  assert.equal((await trigger.GET(request())).status, 503);
  env.CRON_SECRET = "synthetic-trigger-secret";
  assert.equal((await trigger.GET(request("wrong"))).status, 401);
  assert.equal((await trigger.GET(request())).status, 401);
  await policy({ enabled: false });
  const callsBefore = graphCalls.length;
  const response = await trigger.GET(request(env.CRON_SECRET));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(graphCalls.length, callsBefore, "Disabled worker never sends");
  const triggerResult = await response.json();
  assert.equal(triggerResult.scheduling.execution_enabled, false);
  assert.doesNotMatch(JSON.stringify(triggerResult), /claim_token|example\.invalid/);
  await db.exec("UPDATE communication_channel_settings SET automated_enabled=false WHERE channel='email'");
  const offResult = await (await trigger.GET(request(env.CRON_SECRET))).json();
  assert.equal(offResult.scheduling.automatic_delivery_enabled, false);
  await db.exec("UPDATE communication_channel_settings SET automated_enabled=true WHERE channel='email'");
  const onResult = await (await trigger.GET(request(env.CRON_SECRET))).json();
  assert.equal(onResult.scheduling.automatic_delivery_enabled, true);
  assert.equal(graphCalls.length, callsBefore);
  await policy({ enabled: true });
  assert.equal((await db.query("SELECT enabled FROM communication_email_worker_settings")).rows[0].enabled, true,
    "After verified first activation, pause/resume does not reject legitimate Scheduled messages");
  await db.exec("SET ROLE authenticated");
  for (const table of ["communication_email_worker_settings", "communication_email_schedule_state", "communication_email_schedule_attempts"]) {
    await fails(`SELECT * FROM ${table}`, "42501");
  }
  await fails("SELECT claim_due_scheduled_communications()", "42501");
  await db.exec("RESET ROLE; SET ROLE service_role");
  for (const fn of [
    `reserve_communication_email_state('${actor(1)}','${id}',1,'Scheduled')`,
    `complete_reserved_communication_email('${actor(1)}','${id}','accepted')`,
    `validate_communication_email_review('${actor(1)}','${id}',1)`,
  ]) await fails(`SELECT ${fn}`, "42501");
  await db.exec("RESET ROLE");
  assert.ok(serviceInvocations > 10);
  console.log("PASS: Scheduled worker migration rollback/default OFF/activation guard, future/due, atomic lease and final reservation replay protection, dynamic global/automatic/independent masters, all roles/preferences/active/address freshness, actor access, cancellation, 100 cap, Graph outcomes, stale pre-dispatch recovery versus unknown-outcome quarantine, configured retries/exhaustion, real service with isolated SQL and mocked delivery, overlapping workers, completion failure, secure trigger, private RPCs and RLS. No real network or email.");
}
