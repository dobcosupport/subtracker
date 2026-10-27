import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = (name) => fs.readFileSync(path.join(root, "supabase", name), "utf8");
const uuid = (id) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;

test("Company Contacts isolated database workflow", async (t) => {
  const db = await PGlite.create();
  let inScenario = false;
  const rows = async (q, args = []) => {
    if (inScenario) await db.exec("SAVEPOINT assertion_query");
    try {
      const result = (await db.query(q, args)).rows;
      if (inScenario) await db.exec("RELEASE SAVEPOINT assertion_query");
      return result;
    } catch (error) {
      if (inScenario) await db.exec("ROLLBACK TO SAVEPOINT assertion_query; RELEASE SAVEPOINT assertion_query");
      throw error;
    }
  };
  const one = async (q, args = []) => (await rows(q, args))[0];
  const call = async (action, data = {}, actor = uuid(1)) =>
    (await one("SELECT company_contacts_import($1,$2,$3) result", [action, actor, JSON.stringify(data)])).result;
  let serial = 0;
  const source = (Name, Cell = "", Email = "", source_row = 2) => ({ source_row, original: { Name, Cell, Email } });
  const stage = (sources, hash = String(++serial).padStart(64, "0")) => call("stage", {
    file_name: "Synthetic Contacts.xlsx", file_hash: hash, rows: sources, notices: [],
  });
  const get = (batch) => call("get", { batch_id: batch.id });
  const resolve = (review, index, action, contact = null, values = review.rows[index].normalized, confirm_duplicate = false) => call("resolve", {
    batch_id: review.batch.id, revision: review.batch.revision, row_id: review.rows[index].id, action,
    contact_id: contact?.id ?? null, contact_version: contact?.version ?? null, values, confirm_duplicate,
  });
  const apply = (review) => call("apply", { batch_id: review.batch.id, revision: review.batch.revision });
  const contact = async (name, email = null, phone = null) => one(
    "INSERT INTO dobco_contacts(contact_name,email,mobile_phone) VALUES($1,$2,$3) RETURNING *,updated_at::text AS updated_at", [name, email, phone]);
  const scenario = async (name, fn) => t.test(name, async () => {
    await db.exec("BEGIN"); inScenario = true;
    try { await fn(); } finally { inScenario = false; await db.exec("ROLLBACK"); }
  });
  try {
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,name text,email text,role text,status text,system_administrator boolean DEFAULT false);
      CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean);
      INSERT INTO user_profiles VALUES
        ('${uuid(1)}','Synthetic Admin','admin@example.invalid','Admin','Active',true),
        ('${uuid(2)}','Synthetic Reader','reader@example.invalid','Reader','Active',false),
        ('${uuid(3)}','Synthetic Importer','importer@example.invalid','Importer','Active',false),
        ('${uuid(4)}','Synthetic Inactive','inactive@example.invalid','Admin','Inactive',true);
      INSERT INTO role_permissions VALUES
        ('Reader','imports',true,false,false,false),('Reader','settings',true,false,false,false),
        ('Importer','imports',true,false,true,true),('Importer','settings',true,true,false,false);
      CREATE FUNCTION user_has_module_permission(text,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
      CREATE TABLE import_history(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,file_name text NOT NULL,
        import_date timestamptz DEFAULT now(),imported_rows integer DEFAULT 0,successful_rows integer DEFAULT 0,failed_rows integer DEFAULT 0,notes text);
      CREATE TABLE administration_audit_log(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid,user_name text,user_email text,
        action text,object_type text,object_id text,object_label text,details jsonb);
      CREATE TABLE contractor_contacts(id uuid PRIMARY KEY,contact_name text);
      CREATE TABLE contractors(id integer PRIMARY KEY);
      CREATE TABLE communication_recipients(id integer PRIMARY KEY,dobco_contact_id uuid);
    `);
    await db.exec(sql("20261024_dobco_contacts.sql"));
    const snapshot = () => rows("SELECT auth_user_id,name,email,role,status,system_administrator FROM user_profiles ORDER BY auth_user_id");
    const before = await snapshot();
    await assert.rejects(db.exec(sql("20261120_company_contacts_import.sql").replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), (e) => e.code === "22012");
    await db.exec("ROLLBACK");
    assert.equal((await one("SELECT to_regclass('company_contact_import_batches') name")).name, null);
    await db.exec(sql("20261120_company_contacts_import.sql"));
    assert.deepEqual(await snapshot(), before);
    await scenario("permissions, RLS, no API-role helper or direct staging-table access", async () => {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        await assert.rejects(call("list"), (e) => e.code === "42501");
        await assert.rejects(rows("SELECT * FROM company_contact_import_rows"), (e) => e.code === "42501");
        await db.exec("RESET ROLE");
      }
      await db.exec("SET ROLE service_role");
      assert.deepEqual((await call("list")).batches, []);
      await assert.rejects(rows("SELECT company_contact_import_values('{}')"), (e) => e.code === "42501");
      await assert.rejects(rows("INSERT INTO company_contact_import_batches(file_name) VALUES('Denied')"), (e) => e.code === "42501");
      await db.exec("RESET ROLE");
      await assert.rejects(call("stage", { rows: [] }, uuid(2)), (e) => e.code === "42501");
      await assert.rejects(call("list", {}, uuid(4)), (e) => e.code === "42501");
      await assert.rejects(call("list", {}, uuid(999)), (e) => e.code === "42501");
      await rows("UPDATE role_permissions SET can_view=false WHERE role='Reader' AND module='settings'");
      await assert.rejects(call("list", {}, uuid(2)), (e) => e.code === "42501");
      for (const [module, field] of [["imports", "can_view"], ["imports", "can_add"], ["imports", "can_edit"], ["settings", "can_view"], ["settings", "can_manage"]]) {
        await rows(`UPDATE role_permissions SET ${field}=false WHERE role='Importer' AND module=$1`, [module]);
        await assert.rejects(call("stage", { rows: [] }, uuid(3)), (e) => e.code === "42501");
        await rows(`UPDATE role_permissions SET ${field}=true WHERE role='Importer' AND module=$1`, [module]);
      }
    });
    await scenario("fully authorized non-administrator can stage and apply a blank-email contact", async () => {
      let review = await call("stage", { file_name: "Synthetic.xlsx", file_hash: "b".repeat(64), notices: [], rows: [source("Blank Email", "2015550111")] }, uuid(3));
      assert.equal(review.rows[0].status, "REVIEW");
      review = await call("resolve", {
        batch_id: review.batch.id, revision: review.batch.revision, row_id: review.rows[0].id,
        action: "ADD", contact_id: null, values: review.rows[0].normalized,
      }, uuid(3));
      review = await call("apply", { batch_id: review.batch.id, revision: review.batch.revision }, uuid(3));
      assert.equal(review.rows[0].status, "IMPORTED");
      assert.equal((await one("SELECT email FROM dobco_contacts")).email, null);
      assert.equal(review.rows[0].resolution.approved_by, uuid(3));
    });
    await scenario("upload stages all rows atomically, retaining originals without changing live contacts", async () => {
      const existing = await contact("Existing", "existing@outside.invalid");
      const review = await stage([source(" Person ", " (201) 555-0101 ", " Person@Outside.invalid "), source("", "", "", 3)]);
      assert.equal(review.rows.length, 1);
      assert.equal(review.rows[0].original.Email, " Person@Outside.invalid ");
      assert.equal(review.rows[0].normalized.email, "Person@Outside.invalid");
      assert.deepEqual(review.rows[0].matching_keys, ["email:person@outside.invalid", "cell:2015550101", "name:person"]);
      assert.equal((await rows("SELECT * FROM dobco_contacts")).length, 1);
      assert.equal(review.contacts[0].id, existing.id);
      const counts = await one("SELECT (SELECT count(*) FROM company_contact_import_batches) batches,(SELECT count(*) FROM import_history) history");
      await assert.rejects(stage([source("Good"), { source_row: 3, original: { Name: 5, Cell: "", Email: "" } }]));
      assert.deepEqual(await one("SELECT (SELECT count(*) FROM company_contact_import_batches) batches,(SELECT count(*) FROM import_history) history"), counts);
    });
    await scenario("case-insensitive exact email, side-by-side differences, explicit approval and preserved identity/references", async () => {
      const existing = await contact("Old Name", "PERSON@outside.invalid", "201-555-0101");
      await rows("INSERT INTO communication_recipients VALUES(1,$1)", [existing.id]);
      let review = await stage([source("New Name", "", " person@OUTSIDE.invalid ")]);
      assert.equal(review.rows[0].status, "MATCHED");
      assert.equal(review.rows[0].exact_matches[0].id, existing.id);
      assert.equal(review.rows[0].resolution, null);
      assert.equal(review.summary.ready, 0);
      review = await resolve(review, 0, "UPDATE", review.contacts[0]);
      assert.equal(review.rows[0].resolution.values.mobile_phone, existing.mobile_phone, "Blank imports never erase phones");
      review = await apply(review);
      assert.equal(review.rows[0].status, "UPDATED");
      const saved = await one("SELECT * FROM dobco_contacts WHERE id=$1", [existing.id]);
      assert.equal(saved.contact_name, "New Name");
      assert.equal(saved.mobile_phone, existing.mobile_phone);
      assert.equal((await one("SELECT dobco_contact_id FROM communication_recipients")).dobco_contact_id, existing.id);
      assert.equal(review.rows[0].before_contact.contact_name, "Old Name");
      assert.equal(review.rows[0].after_contact.contact_name, "New Name");
      await rows("UPDATE dobco_contacts SET contact_name='Later edit' WHERE id=$1", [existing.id]);
      assert.equal((await get(review.batch)).rows[0].after_contact.contact_name, "New Name", "Historical evidence survives later edits");
      await assert.rejects(resolve(review, 0, "UNDO"), /read-only/);
    });
    await scenario("blank email/name suggestions and differently formatted phones never silently match or update", async () => {
      const existing = await contact("Same Person", "saved@outside.invalid", "(201) 555-0101");
      let review = await stage([source(" same   person ", "201.555.0101")]);
      assert.equal(review.rows[0].status, "REVIEW");
      assert.equal(review.rows[0].suggestions[0].id, existing.id);
      assert.equal(review.rows[0].resolution, null);
      review = await apply(review);
      assert.equal(review.summary.imported, 0);
      await assert.rejects(resolve(review, 0, "ADD"), /duplicate/i);
      review = await resolve(await get(review.batch), 0, "KEEP", review.contacts[0]);
      review = await apply(review);
      assert.equal(review.rows[0].contact_id, existing.id);
      assert.equal((await one("SELECT email FROM dobco_contacts")).email, existing.email);
      assert.equal(review.rows[0].resolution.action, "KEEP");
    });
    await scenario("invalid/parenthetical values require correction or Keep/Skip; originals and all decisions retained", async () => {
      let review = await stage([source("Person (PM)", "2015550101 (personal)", "person@outside.invalid (PM)"), source("", "", "valid@outside.invalid", 3)]);
      assert.equal(review.rows[0].status, "REVIEW");
      assert.ok(review.rows[0].issues.length >= 3);
      assert.ok(review.rows[1].issues.includes("Name is required."));
      await assert.rejects(resolve(review, 0, "ADD"), /valid email|Review Cell|Review Name/);
      review = await resolve(review, 0, "ADD", null, { contact_name: "Person", email: "person@outside.invalid", mobile_phone: "2015550101" });
      review = await resolve(review, 0, "UNDO");
      assert.equal(review.rows[0].resolution, null);
      review = await resolve(review, 0, "ADD", null, { contact_name: "Person", email: "person@outside.invalid", mobile_phone: "2015550101" });
      review = await resolve(review, 1, "SKIP");
      review = await apply(review);
      assert.equal(review.rows[0].status, "IMPORTED");
      assert.equal(review.rows[1].status, "SKIP");
      assert.equal(review.rows[0].original.Name, "Person (PM)");
      assert.deepEqual(review.rows[0].events.map((e) => e.action), ["ADD", "UNDO", "ADD", "APPLIED"]);
    });
    await scenario("duplicate rows, repeated upload/apply and cross-batch duplicates cannot create a second contact", async () => {
      const sources = [source("Duplicate", "2015550101", "same@outside.invalid"), source("Duplicate", "2015550101", "SAME@outside.invalid", 3)];
      const hash = "a".repeat(64);
      let review = await stage(sources, hash);
      assert.deepEqual(review.rows[0].duplicate_rows, [3]);
      assert.equal((await stage(sources, hash)).batch.id, review.batch.id);
      await assert.rejects(resolve(review, 0, "ADD"), /duplicate/i);
      review = await resolve(review, 0, "ADD", null, review.rows[0].normalized, true);
      review = await resolve(review, 1, "ADD", null, review.rows[1].normalized, true);
      const stale = review;
      review = await apply(review);
      assert.equal(review.summary.imported, 1);
      assert.equal(review.summary.errors, 1);
      assert.match(review.rows[1].error, /already|another contact/i);
      assert.equal((await apply(stale)).summary.imported, 1);
      assert.equal((await rows("SELECT * FROM dobco_contacts")).length, 1);
      assert.equal((await stage(sources, hash)).batch.id, review.batch.id);
      review = await resolve(review, 1, "KEEP", review.contacts[0]);
      review = await apply(review);
      assert.equal(review.batch.status, "Complete");
      const another = await stage([source("Duplicate", "2015550101", "same@outside.invalid")]);
      await assert.rejects(resolve(another, 0, "ADD", null, another.rows[0].normalized, true), /Email already/);
      assert.equal((await rows("SELECT * FROM dobco_contacts")).length, 1);
    });
    await scenario("stale revision/contact and conflicting email are rejected, partial success safely retryable", async () => {
      const a = await contact("A", "a@outside.invalid", "2015550101");
      await contact("B", "b@outside.invalid", "2015550102");
      let review = await stage([source("A Updated", "", "a@outside.invalid"), source("New", "", "new@outside.invalid", 3)]);
      const initial = review;
      await assert.rejects(resolve(review, 0, "UPDATE", { ...review.contacts.find((c) => c.id === a.id), version: "stale" }), /Contact changed/);
      await assert.rejects(resolve(review, 0, "UPDATE", review.contacts.find((c) => c.id === a.id), { contact_name: "A", email: "b@outside.invalid", mobile_phone: null }), /Email already/);
      review = await resolve(review, 0, "UPDATE", review.contacts.find((c) => c.id === a.id));
      await assert.rejects(resolve(initial, 1, "SKIP"), /Import changed/);
      review = await resolve(review, 1, "ADD");
      await rows("UPDATE dobco_contacts SET contact_name='Concurrent manual edit' WHERE id=$1", [a.id]);
      review = await apply(review);
      assert.equal(review.summary.errors, 1);
      assert.equal(review.summary.imported, 1);
      assert.match(review.rows[0].error, /changed after resolution/);
      assert.equal(review.rows[0].resolution, null);
      assert.equal(review.batch.status, "Partial");
      review = await resolve(review, 0, "UPDATE", review.contacts.find((c) => c.id === a.id));
      review = await apply(review);
      assert.equal(review.summary.updated, 1);
      assert.equal((await rows("SELECT * FROM dobco_contacts")).length, 3);
      const history = await one("SELECT * FROM import_history WHERE id=$1", [review.batch.import_history_id]);
      assert.equal(history.successful_rows, 2);
      assert.equal(history.failed_rows, 0);
      assert.ok((await rows("SELECT * FROM administration_audit_log WHERE action LIKE 'COMPANY_CONTACTS_%'")).length >= 5);
    });
    await scenario("new contacts use established defaults; users, contractor contacts, communications and permissions are untouched", async () => {
      const snapshotBefore = await snapshot();
      const permissionsBefore = await rows("SELECT * FROM role_permissions ORDER BY role,module");
      let review = await stage([source("Independent", "", "external@example.org")]);
      review = await resolve(review, 0, "ADD");
      review = await apply(review);
      const saved = await one("SELECT * FROM dobco_contacts");
      assert.equal(saved.is_active, true);
      assert.equal(saved.user_profile_id, null);
      assert.equal(saved.receives_internal_email, false);
      assert.equal(saved.receives_internal_sms, false);
      assert.equal(saved.sms_consent_recorded, false);
      assert.equal(saved.mobile_phone, null);
      assert.equal(review.rows[0].contact_id, saved.id);
      assert.deepEqual(await snapshot(), snapshotBefore);
      assert.deepEqual(await rows("SELECT * FROM role_permissions ORDER BY role,module"), permissionsBefore);
      for (const table of ["contractors", "contractor_contacts", "communication_recipients"]) {
        assert.equal((await rows(`SELECT * FROM ${table}`)).length, 0);
      }
      assert.equal((await call("list", {}, uuid(2))).batches.length, 1);
    });
    await scenario("an audit failure rolls back the row contact write and retains an explicit retryable error", async () => {
      let review = await stage([source("Audit Failure", "", "audit@example.org")]);
      review = await resolve(review, 0, "ADD");
      await db.exec("ALTER TABLE administration_audit_log ADD CONSTRAINT synthetic_audit_failure CHECK(action<>'COMPANY_CONTACTS_ADD')");
      review = await apply(review);
      assert.equal(review.summary.errors, 1);
      assert.equal(review.summary.imported, 0);
      assert.match(review.rows[0].error, /synthetic_audit_failure/);
      assert.equal((await rows("SELECT * FROM dobco_contacts")).length, 0, "No contact survives an unsuccessful row transaction");
      await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT synthetic_audit_failure");
      review = await resolve(review, 0, "ADD");
      review = await apply(review);
      assert.equal(review.summary.imported, 1);
      assert.equal((await rows("SELECT * FROM dobco_contacts")).length, 1);
    });
  } finally { await db.close(); }
});
