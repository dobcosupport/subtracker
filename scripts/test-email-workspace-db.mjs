import assert from "node:assert/strict";

export async function testEmailWorkspace({ db, read, fails, actor, draftSQL, manualEmailDraft }) {
  const migration = read("20261213_email_workspace.sql");
  assert.doesNotMatch(migration, /cron\.schedule|net\.http|http_post/i);
  const before = (await db.query("SELECT id,status,body,revision FROM communication_messages ORDER BY id")).rows;
  const settingsBefore = (await db.query("SELECT revision,enabled,automated_enabled FROM communication_channel_settings WHERE channel='email'")).rows;
  await fails(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='communication_recipients' AND column_name='recipient_role'")).rows[0].n, 0);
  await db.exec(migration);
  assert.deepEqual((await db.query("SELECT id,status,body,revision FROM communication_messages ORDER BY id")).rows, before);
  assert.deepEqual((await db.query("SELECT revision,enabled,automated_enabled FROM communication_channel_settings WHERE channel='email'")).rows, settingsBefore);
  assert.equal((await db.query("SELECT count(*)::int n FROM communication_recipients WHERE recipient_role<>'to'")).rows[0].n, 0);
  await db.exec(`UPDATE communication_channel_settings SET enabled=true WHERE channel='email';
    UPDATE dobco_contacts SET is_active=true,receives_internal_email=true WHERE id='${actor(102)}';
    UPDATE contractor_contacts SET is_active=true,receives_compliance_email=true WHERE id='${actor(101)}';
    UPDATE microsoft_email_connection_state SET settings_revision=(SELECT revision FROM communication_channel_settings WHERE channel='email'),
      authentication_status='Verified',delivery_status='Accepted by Graph';`);
  const c = (await db.query(`SELECT * FROM contractor_contacts WHERE id='${actor(101)}'`)).rows[0];
  const d = (await db.query(`SELECT * FROM dobco_contacts WHERE id='${actor(102)}'`)).rows[0];
  const recipients = [
    { recipient_role: "to", recipient_type: "dobco_contact", recipient_name: d.contact_name, email: d.email,
      mobile_phone: d.mobile_phone, contractor_contact_id: null, dobco_contact_id: d.id },
    { recipient_role: "cc", recipient_type: "contractor_contact", recipient_name: c.contact_name, email: c.email,
      mobile_phone: c.mobile_phone, contractor_contact_id: c.id, dobco_contact_id: null },
    { recipient_role: "bcc", recipient_type: "external", recipient_name: "Synthetic external", email: "external@example.invalid",
      mobile_phone: null, contractor_contact_id: null, dobco_contact_id: null },
  ];
  const draft = { ...manualEmailDraft, template_id: null, template_revision: undefined,
    subject: "Workspace fixture", body: "Synthetic workspace message", recipients, contractor_ids: [1], project_ids: [1] };
  const save = async input => (await db.query(draftSQL(1, input))).rows[0].id;
  const id = await save(draft);
  const revision = (await db.query("SELECT revision FROM communication_channel_settings WHERE channel='email'")).rows[0].revision;
  const reserve = message => `SELECT reserve_reviewed_communication_email_send('${actor(1)}','${message}',${revision},1) AS v`;
  const evaluate = async r => (await db.query(`SELECT communication_email_exclusion('${r.recipient_type}',
    ${r.contractor_contact_id || r.dobco_contact_id ? `'${r.contractor_contact_id || r.dobco_contact_id}'` : "NULL"},'${r.email}') AS reason`)).rows[0].reason;
  assert.deepEqual((await db.query(`SELECT email,recipient_role FROM communication_recipients WHERE message_id='${id}' ORDER BY recipient_role`)).rows,
    recipients.map(r => ({ email: r.email, recipient_role: r.recipient_role })).sort((a, b) => a.recipient_role.localeCompare(b.recipient_role)));
  for (const r of recipients) assert.equal(await evaluate(r), null);
  for (const [field, blocked, allowed] of [
    ["enabled", [0, 1, 2], []], ["contractor_email_enabled", [1, 2], [0]], ["internal_email_enabled", [0], [1, 2]],
  ]) {
    await db.exec(`UPDATE communication_channel_settings SET ${field}=false WHERE channel='email'`);
    for (const i of blocked) assert.ok(await evaluate(recipients[i]), `${field} blocks ${recipients[i].recipient_type}`);
    for (const i of allowed) assert.equal(await evaluate(recipients[i]), null);
    await fails(reserve(id), "22023");
    await db.exec(`UPDATE communication_channel_settings SET ${field}=true WHERE channel='email'`);
  }
  for (const [field, recipient] of [["contractor_email_enabled", recipients[0]], ["internal_email_enabled", recipients[1]]]) {
    const permitted = await save({ ...draft, recipients: [recipient] });
    await db.exec(`UPDATE communication_channel_settings SET ${field}=false WHERE channel='email'`);
    await db.query(reserve(permitted));
    await db.exec(`SELECT finish_communication_email_send('${actor(1)}','${permitted}','accepted');
      UPDATE communication_channel_settings SET ${field}=true WHERE channel='email'`);
  }
  await db.exec(`UPDATE contractor_contacts SET receives_compliance_email=false WHERE id='${c.id}'`);
  await fails(reserve(id), "22023");
  assert.ok(await evaluate({ ...recipients[1], recipient_type: "external", contractor_contact_id: null }));
  await db.exec(`UPDATE contractor_contacts SET receives_compliance_email=true WHERE id='${c.id}';
    UPDATE dobco_contacts SET receives_internal_email=false WHERE id='${d.id}'`);
  await fails(reserve(id), "22023");
  assert.ok(await evaluate({ ...recipients[0], recipient_type: "external", dobco_contact_id: null }));
  await db.exec(`UPDATE dobco_contacts SET receives_internal_email=true WHERE id='${d.id}'`);
  const changed = await save({ ...draft, recipients: [recipients[1]], subject: "Changed after save" });
  await db.exec(`UPDATE contractor_contacts SET email='changed@example.invalid' WHERE id='${c.id}'`);
  await fails(reserve(changed), "22023");
  await db.exec(`UPDATE contractor_contacts SET email='${c.email}' WHERE id='${c.id}'`);
  for (const role of ["to", "cc", "bcc"]) {
    const r = { ...recipients[1], recipient_role: role };
    const m = await save({ ...draft, recipients: [r] });
    await db.exec(`UPDATE contractor_contacts SET receives_compliance_email=false WHERE id='${c.id}'`);
    await fails(reserve(m), "22023");
    await db.exec(`UPDATE contractor_contacts SET receives_compliance_email=true WHERE id='${c.id}'`);
  }
  const hundred = Array.from({ length: 100 }, (_, i) => ({ ...recipients[2], recipient_name: `Synthetic ${i}`,
    recipient_role: ["to", "cc", "bcc"][i % 3], email: `fixture${i}@example.invalid` }));
  const max = await save({ ...draft, recipients: hundred });
  assert.equal((await db.query(`SELECT count(*)::int n FROM communication_recipients WHERE message_id='${max}'`)).rows[0].n, 100);
  await fails(draftSQL(1, { ...draft, recipients: [...hundred, { ...recipients[2], email: "extra@example.invalid" }] }), "22023");
  await fails(draftSQL(1, { ...draft, recipients: [recipients[0], { ...recipients[0], email: d.email.toUpperCase(), recipient_role: "bcc" }] }), "22023");
  await fails(draftSQL(1, { ...draft, recipients: [{ ...recipients[0], recipient_role: "invalid" }] }), "22023");
  const planned = await save(draft);
  await db.exec(`SELECT plan_communication('${actor(1)}','${planned}',1,'schedule',now()+interval '1 day')`);
  assert.equal((await db.query(`SELECT status FROM communication_messages WHERE id='${planned}'`)).rows[0].status, "Scheduled");
  assert.deepEqual((await db.query(`SELECT recipient_role FROM communication_recipients WHERE message_id='${planned}' ORDER BY recipient_role`)).rows.map(r => r.recipient_role), ["bcc", "cc", "to"]);
  const reservation = (await db.query(reserve(id))).rows[0].v;
  assert.deepEqual(reservation.recipients.map(r => r.recipient_role).sort(), ["bcc", "cc", "to"]);
  await fails(`UPDATE communication_recipients SET recipient_role='bcc' WHERE message_id='${id}' AND recipient_role='to'`, "23514");
  await db.exec(`SELECT finish_communication_email_send('${actor(1)}','${id}','accepted')`);
  assert.equal((await db.query(`SELECT status FROM communication_messages WHERE id='${id}'`)).rows[0].status, "Sent");
  const editId = await save(draft);
  await db.query(draftSQL(1, { ...draft, revision: 1, recipients: recipients.map(r => ({ ...r, recipient_role: "bcc" })) }, editId));
  assert.equal((await db.query(`SELECT count(*)::int n FROM communication_recipients WHERE message_id='${editId}' AND recipient_role='bcc'`)).rows[0].n, 3);
  await db.exec("SET ROLE service_role");
  await fails(`SELECT reserve_communication_email_send_before_workspace('${actor(1)}','${editId}',${revision})`, "42501");
  await fails(`SELECT reserve_communication_email_send_before_notice('${actor(1)}','${editId}',${revision})`, "42501");
  await fails(`SELECT save_communication_draft_before_workspace('${actor(1)}',NULL,'{}')`, "42501");
  await fails(`SELECT communication_email_workspace_controls('${actor(2)}')`, "42501");
  await db.exec("RESET ROLE");
  const s = (await db.query("SELECT * FROM communication_channel_settings WHERE channel='email'")).rows[0];
  const controlsInput = Object.fromEntries(["provider", "enabled", "automated_enabled", "from_name", "from_address", "reply_to_address",
    "microsoft_tenant_id", "microsoft_client_id", "revision"].map(k => [k, s[k]]));
  controlsInput.contractor_email_enabled = false; controlsInput.internal_email_enabled = true;
  await db.query(`SELECT save_communication_settings('${actor(1)}','email','${JSON.stringify(controlsInput).replaceAll("'", "''")}'::jsonb)`);
  assert.deepEqual((await db.query("SELECT contractor_email_enabled,internal_email_enabled,revision FROM communication_channel_settings WHERE channel='email'")).rows[0],
    { contractor_email_enabled: false, internal_email_enabled: true, revision: s.revision + 1 });
  const controlSnapshot = (await db.query(`SELECT communication_email_workspace_controls('${actor(1)}') AS v`)).rows[0].v;
  assert.equal(controlSnapshot.contractor_email_enabled, false); assert.equal(controlSnapshot.internal_email_enabled, true);
  assert.equal((await db.query("SELECT settings_revision FROM microsoft_email_connection_state")).rows[0].settings_revision, s.revision + 1,
    "Child-only switch changes must not block the other recipient type by invalidating the unchanged provider");
  const internalOnly = await save({ ...draft, recipients: [recipients[0]] });
  await db.query(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${internalOnly}',${s.revision + 1},1)`);
  await db.exec(`SELECT finish_communication_email_send('${actor(1)}','${internalOnly}','accepted')`);
  const blockedContractor = await save({ ...draft, recipients: [recipients[1]] });
  await fails(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${blockedContractor}',${s.revision + 1},1)`, "22023");
  const settingsChange = async changes => {
    const row = (await db.query("SELECT * FROM communication_channel_settings WHERE channel='email'")).rows[0];
    const input = Object.fromEntries([...Object.keys(controlsInput)].map(k => [k, row[k]]));
    Object.assign(input, changes);
    await db.query(`SELECT save_communication_settings('${actor(1)}','email','${JSON.stringify(input).replaceAll("'", "''")}'::jsonb)`);
    return row.revision + 1;
  };
  const internalOffRevision = await settingsChange({ contractor_email_enabled: true, internal_email_enabled: false });
  const contractorOnly = await save({ ...draft, recipients: [recipients[1]] });
  await db.query(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${contractorOnly}',${internalOffRevision},1)`);
  await db.exec(`SELECT finish_communication_email_send('${actor(1)}','${contractorOnly}','accepted')`);
  const globalOffRevision = await settingsChange({ enabled: false });
  assert.equal((await db.query("SELECT settings_revision FROM microsoft_email_connection_state")).rows[0].settings_revision, internalOffRevision,
    "Changing the global switch retains its existing verification invalidation behavior");
  const globallyBlocked = await save({ ...draft, recipients: [recipients[1]] });
  await fails(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${globallyBlocked}',${globalOffRevision},1)`, "22023");
  const globalOnRevision = await settingsChange({ enabled: true });
  await fails(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${globallyBlocked}',${globalOnRevision},1)`, "22023");
  console.log("PASS: Email workspace migration rollback, legacy preservation, global/contractor/internal controls, current individual preferences and address changes, raw-address bypass prevention, all To/Cc/Bcc roles, mixed lists, combined 100-recipient limit, draft edits, inert scheduling, frozen audit roles, Graph reservation/finish and private bypass prevention.");
}
