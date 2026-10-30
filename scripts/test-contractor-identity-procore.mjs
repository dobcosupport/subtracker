import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fn = (file, name) => read("supabase", file).match(new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
const MIGRATION = read("supabase", "20261204_contractor_identity_procore.sql");

const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const result = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(name), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: result, exports: result.exports,
    require: (id) => load(id.replace("@/lib/", "src/lib/").replace("@/types/", "types/") + ".ts") });
  cache.set(name, result.exports);
  return result.exports;
}
const { buildProcorePreview, procoreIdentityCandidates, procoreCompany, procoreVendorKey } = load("src/lib/procore-preview.ts");
const { PROCORE_HEADINGS } = load("types/procore-import.ts");

let rowNumber = 1;
const row = (name, company = {}, extra = {}) => ({
  ...Object.fromEntries(PROCORE_HEADINGS.map((h) => [h, ""])), row: ++rowNumber,
  "Company (Vendor) > Name": name,
  "Company (Vendor) > Business Phone": company.phone ?? "", "Company (Vendor) > Address": company.address ?? "",
  "Company (Vendor) > City": company.city ?? "", "Company (Vendor) > State": company.state ?? "NJ",
  "Company (Vendor) > Zip": company.zip ?? "", "Project > Number": "25-001", ...extra,
});
const ROWS = [
  // Strong possible: variant name + phone + address of contractor 201.
  row("Harborview Window Mfg.", { phone: "732-555-0201", address: "10 Harbor Street", zip: "07001" }),
  row("Harborview Window Mfg.", { phone: "732-555-0201", address: " 10 Harbor Street ", zip: "07001" }),
  row("Brand New Vendor Inc", { phone: "732-555-0299" }),
  // Phone only (informational) against contractor 203.
  row("Nothing Alike Painting", { phone: "732-555-0203" }),
  // Exact normalized name of contractor 202.
  row("Exact Name Builders, LLC"),
  // Already bound to contractor 204 by a saved Procore vendor mapping.
  row("Bound Vendor Company"),
  // Two vendors in one file that are variants of each other and of no existing contractor.
  row("Zephyr Glass Mfg."),
  row("Zephyr Glass Manufacturing"),
];

test("contractor identity: Procore duplicate prevention (Phase 2)", async (t) => {
  const db = await PGlite.create();
  let inScenario = false;
  const query = async (sql, args = []) => {
    if (inScenario) await db.exec("SAVEPOINT assertion_query");
    try {
      const rows = (await db.query(sql, args)).rows;
      if (inScenario) await db.exec("RELEASE SAVEPOINT assertion_query");
      return rows;
    } catch (e) {
      if (inScenario) await db.exec("ROLLBACK TO SAVEPOINT assertion_query; RELEASE SAVEPOINT assertion_query");
      throw e;
    }
  };
  const one = async (sql, args) => (await query(sql, args))[0];
  const scenario = (name, body) => t.test(name, async () => {
    await db.exec("BEGIN"); inScenario = true;
    try { await body(); } finally { inScenario = false; await db.exec("ROLLBACK"); }
  });
  const sqlError = async (promise, code, pattern) => {
    let error;
    try { await promise; } catch (e) { error = e; }
    assert.ok(error, "expected an error");
    if (code) assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  };

  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT null::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_user::text$$;
  `);
  await db.exec(read("scripts", "fixtures", "company-merge-installed-schema.sql"));
  await db.exec(fn("20261104_mycoi_insurance_project_ownership.sql", "contractor_import_name_key"));
  await db.exec(read("supabase", "20261121_company_merge.sql"));
  await db.exec(read("supabase", "20261203_contractor_identity_foundation.sql"));
  // Installed Procore functions: helpers from 20261110/20261112, then the real 20261113 and 20261117 migrations.
  await db.exec(fn("20261110_procore_import_workflow.sql", "procore_require_actor"));
  await db.exec(fn("20261110_procore_import_workflow.sql", "procore_import_audit"));
  await db.exec(fn("20261112_procore_project_mappings.sql", "procore_resolve_project"));
  await db.exec(read("supabase", "20261113_procore_contractor_match_override.sql"));
  await db.exec(read("supabase", "20261117_procore_import_source_lookup.sql"));
  await db.exec(`
    GRANT EXECUTE ON FUNCTION public.procore_save_review(UUID,INTEGER,JSONB,UUID),
      public.procore_apply_import(UUID,INTEGER,TEXT,JSONB,UUID) TO service_role;
    INSERT INTO app_roles(role,is_system) VALUES('Administrator',true),('Reviewer',false);
    INSERT INTO role_permissions(role,module,can_view,can_manage,can_add,can_edit) VALUES
      ('Reviewer','imports',true,true,true,true),('Reviewer','projects',true,true,true,true),
      ('Reviewer','contractors',true,true,false,true);
    INSERT INTO auth.users VALUES('${uuid(1)}'),('${uuid(2)}');
    INSERT INTO user_profiles(auth_user_id,name,email,role,system_administrator,status) VALUES
      ('${uuid(1)}','Synthetic Admin','admin@example.invalid','Administrator',true,'Active'),
      ('${uuid(2)}','Synthetic Reviewer','reviewer@example.invalid','Reviewer',false,'Active');
    INSERT INTO relationship_sources(source) VALUES('MANUAL'),('PROCORE'),('MYCOI') ON CONFLICT DO NOTHING;
    INSERT INTO projects(id,project_number,project_name,public_works) VALUES(1,'25-001','Synthetic Project',true);
    INSERT INTO contractors(id,company_name,phone,address_1,zip_code,nj_pwc_number,active) VALUES
      (201,'Harborview Window Manufacturing Corporation','732-555-0201','10 Harbor St','07001','800201',true),
      (202,'Exact Name Builders LLC',NULL,NULL,NULL,NULL,true),
      (203,'Phone Twin Holdings','732-555-0203',NULL,NULL,NULL,true),
      (204,'Bound Vendor Holdings',NULL,NULL,NULL,NULL,true);
    INSERT INTO import_history(id,file_name) VALUES(4001,'Prior Procore');
    INSERT INTO procore_import_runs(id,file_name,created_by,source_rows) VALUES
      ('${uuid(49)}','Prior.xlsx','${uuid(1)}','[{"row":1}]'),('${uuid(50)}','Synthetic.xlsx','${uuid(1)}',$json$${JSON.stringify(ROWS)}$json$);
    INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,accepted_by,import_run_id,import_history_id)
      VALUES(contractor_import_name_key('Bound Vendor Company'),'Bound Vendor Company',204,'${uuid(1)}','${uuid(49)}',4001);
  `);
  const RUN = uuid(50), ADMIN = uuid(1), REVIEWER = uuid(2);
  const key = (name) => procoreVendorKey(name);
  const A = key("Harborview Window Mfg."), B = key("Brand New Vendor Inc"), C = key("Nothing Alike Painting");
  const D = key("Exact Name Builders, LLC"), E = key("Bound Vendor Company");
  const Z1 = key("Zephyr Glass Mfg."), Z2 = key("Zephyr Glass Manufacturing");
  assert.equal(new Set([A, B, C, D, E, Z1, Z2]).size, 7);
  for (const name of ["Harborview Window Mfg.", "Exact Name Builders, LLC", "Bound Vendor Company", "Zephyr Glass Mfg."]) {
    assert.equal((await one("SELECT contractor_import_name_key($1) k", [name])).k, key(name), "TS and SQL vendor keys agree");
  }

  const definition = (sig) => `SELECT pg_get_functiondef('${sig}'::regprocedure) d, proacl::text acl FROM pg_proc WHERE oid='${sig}'::regprocedure`;
  const SAVE = "procore_save_review(uuid,integer,jsonb,uuid)", APPLY = "procore_apply_import(uuid,integer,text,jsonb,uuid)";
  const before = { save: await one(definition(SAVE)), apply: await one(definition(APPLY)) };
  const procSnapshot = `SELECT p.oid::regprocedure::text sig, md5(p.prosrc) src FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`;
  const procsBefore = await query(procSnapshot);
  const dataSnapshot = `SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) h FROM (
    SELECT to_jsonb(c)::text t FROM contractors c UNION ALL SELECT to_jsonb(m)::text FROM procore_vendor_mappings m
    UNION ALL SELECT to_jsonb(r)::text FROM procore_import_runs r) x`;
  const dataBefore = await one(dataSnapshot);

  await sqlError(db.exec(MIGRATION.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), null, /division by zero/);
  await db.exec("ROLLBACK");
  assert.equal((await one(definition(SAVE))).d, before.save.d, "failed migration leaves the installed function unchanged");
  await db.exec(MIGRATION);

  // ---- helpers driving the real preview builder and RPCs ----
  const runRow = () => one(`SELECT revision,decisions,imported_rows FROM procore_import_runs WHERE id=$1`, [RUN]);
  const reference = async () => (await one("SELECT procore_import_reference() v")).v;
  const identity = async (ref) => (await one("SELECT procore_identity_matches($1::jsonb) v",
    [JSON.stringify(procoreIdentityCandidates(ROWS, ref))])).v;
  const preview = async () => {
    const run = await runRow(); const ref = await reference();
    return buildProcorePreview(ROWS, run.decisions, ref, run.imported_rows, await identity(ref));
  };
  const vendor = (p, k) => p.vendors.find((v) => v.key === k);
  const save = async (vendors, actor = ADMIN) => {
    const run = await runRow();
    const decisions = { vendors: { ...run.decisions.vendors, ...vendors } };
    return one("SELECT r.revision,r.decisions FROM procore_save_review($1,$2,$3::jsonb,$4) r",
      [RUN, run.revision, JSON.stringify(decisions), actor]);
  };
  const apply = async (plan) => {
    const run = await runRow();
    return (await one("SELECT procore_apply_import($1,$2,$3,$4::jsonb,$5) v",
      [RUN, run.revision, (await reference()).token, JSON.stringify(plan), ADMIN])).v;
  };
  // The plan the UI would submit if the preview gate were bypassed by a stale or tampered client.
  const forcedPlan = async (k) => {
    const run = await runRow(); const ref = await reference();
    const p = buildProcorePreview(ROWS, run.decisions, ref, run.imported_rows, { [k]: [] });
    const plan = p.ready.filter((v) => v.key === k);
    assert.equal(plan.length, 1, `forced plan for ${k}`);
    return plan;
  };
  const identityDetail = (error) => JSON.parse(error.detail);
  const contractorCount = async () => (await one("SELECT count(*)::int n FROM contractors")).n;
  const auditCount = async (action) => (await one(
    "SELECT count(*)::int n FROM administration_audit_log WHERE action=$1 AND object_id=$2", [action, RUN])).n;

  await t.test("migration replaces only the two Procore functions and adds two helpers", async () => {
    const after = new Map((await query(procSnapshot)).map((p) => [p.sig, p.src]));
    const changed = procsBefore.filter((p) => after.get(p.sig) !== p.src).map((p) => p.sig).sort();
    assert.deepEqual(changed, [APPLY, SAVE].sort());
    const added = [...after.keys()].filter((s) => !procsBefore.some((p) => p.sig === s)).sort();
    assert.deepEqual(added, ["procore_identity_candidate(jsonb,text)", "procore_identity_matches(jsonb)"]);
    assert.equal((await one(definition(SAVE))).acl, before.save.acl, "save_review grants preserved");
    assert.equal((await one(definition(APPLY))).acl, before.apply.acl, "apply_import grants preserved");
    const acl = await one(`SELECT has_function_privilege('service_role','procore_identity_matches(jsonb)','EXECUTE') m,
      has_function_privilege('service_role','procore_identity_candidate(jsonb,text)','EXECUTE') c,
      has_function_privilege('anon','procore_identity_matches(jsonb)','EXECUTE') a,
      has_function_privilege('authenticated','procore_identity_matches(jsonb)','EXECUTE') u`);
    assert.deepEqual(acl, { m: true, c: false, a: false, u: false });
    assert.equal((await one(dataSnapshot)).h, dataBefore.h, "migration changes no rows");
    assert.doesNotMatch(MIGRATION, /CREATE\s+(TABLE|TRIGGER|INDEX|UNIQUE)|ALTER\s+TABLE|DROP\s|(UPDATE|DELETE\s+FROM)\s+(public\.)?contractors\b/i);
  });

  await t.test("unchanged lines: every line of the 20261113/20261117 bodies is preserved (Phase 2 only inserts lines)", async () => {
    const body = (sql, name) => sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0].split("\n");
    const removedFrom = (oldLines, newLines) => oldLines.filter((l) => !newLines.includes(l));
    const oldSave = body(read("supabase", "20261113_procore_contractor_match_override.sql"), "procore_save_review");
    const oldApply = body(read("supabase", "20261117_procore_import_source_lookup.sql"), "procore_apply_import");
    const newSave = body(MIGRATION, "procore_save_review"), newApply = body(MIGRATION, "procore_apply_import");
    assert.deepEqual(removedFrom(oldSave, newSave), []);
    assert.deepEqual(removedFrom(oldApply, newApply), []);
  });

  await t.test("procore_identity_candidate mirrors the TypeScript company derivation", async () => {
    const groups = new Map();
    for (const r of ROWS) groups.set(key(r["Company (Vendor) > Name"]), [...(groups.get(key(r["Company (Vendor) > Name"])) ?? []), r]);
    for (const [k, source] of groups) {
      const sql = (await one("SELECT procore_identity_candidate($1::jsonb,$2) v", [JSON.stringify(ROWS), k])).v;
      assert.deepEqual(sql, { source: "PROCORE", procore_vendor_key: k, ...procoreCompany(source).company }, k);
    }
    const conflict = [row("Split Phone Co", { phone: "1" }), row(" Split Phone Co ", { phone: "2", zip: " 07001 " })];
    const sql = (await one("SELECT procore_identity_candidate($1::jsonb,$2) v", [JSON.stringify(conflict), key("Split Phone Co")])).v;
    assert.deepEqual(sql, { source: "PROCORE", procore_vendor_key: key("Split Phone Co"), ...procoreCompany(conflict).company });
    assert.equal(sql.phone, null, "inconsistent field is withheld");
    assert.equal(sql.zip_code, "07001");
    assert.equal((await one("SELECT procore_identity_candidate($1::jsonb,'missing vendor') v", [JSON.stringify(ROWS)])).v, null);
  });

  await t.test("procore_identity_matches returns every candidate key, classified by the central matcher", async () => {
    const ref = await reference();
    const candidates = procoreIdentityCandidates(ROWS, ref);
    assert.equal(candidates.some((c) => c.candidate_key === E), false, "mapped vendors are not re-matched");
    const m = await identity(ref);
    assert.deepEqual(Object.keys(m).sort(), [A, B, C, D, Z1, Z2].sort());
    assert.deepEqual(m[B], []);
    assert.deepEqual(m[A].map((x) => [x.contractor_id, x.match_class, x.disposition]), [[201, "strong_possible", "review_required"]]);
    assert.deepEqual(m[C].map((x) => [x.contractor_id, x.disposition]), [[203, "informational"]]);
    assert.deepEqual(m[D].map((x) => [x.contractor_id, x.match_class, x.disposition]), [[202, "exact_name", "review_required"]]);
    assert.deepEqual(m[Z1], [], "intra-file variants are not existing contractors");
    assert.deepEqual((await one("SELECT procore_identity_matches('[]'::jsonb) v")).v, {});
  });

  await scenario("plain ADD with no possible match imports unchanged", async () => {
    await save({ [B]: { action: "ADD" } });
    const p = await preview();
    assert.equal(vendor(p, B).identityStatus, "clear");
    const plan = p.ready.filter((v) => v.key === B);
    assert.equal(plan.length, 1);
    const result = await apply(plan);
    assert.equal(result.contractors_created, 1);
    assert.equal((await one("SELECT creation_source FROM contractors WHERE company_name='Brand New Vendor Inc'")).creation_source, "PROCORE");
    assert.equal(await auditCount("PROCORE_SEPARATE_CONTRACTOR_CREATED"), 0);
  });

  await scenario("informational phone-only match is shown but never blocks", async () => {
    await save({ [C]: { action: "ADD" } });
    const v = vendor(await preview(), C);
    assert.equal(v.identityStatus, "clear");
    assert.equal(v.identityMatches[0].disposition, "informational");
    assert.equal(v.issues.some((i) => /Possible existing contractor/.test(i)), false);
    assert.equal((await apply((await preview()).ready.filter((x) => x.key === C))).contractors_created, 1);
  });

  await scenario("variant + phone/address requires review: preview withholds it and the server rejects a forced plan", async () => {
    await save({ [A]: { action: "ADD" } });
    const v = vendor(await preview(), A);
    assert.equal(v.identityStatus, "review_required");
    assert.equal((await preview()).ready.some((x) => x.key === A), false);
    assert.ok(v.issues.some((i) => i.includes("Harborview Window Manufacturing Corporation (#201")), v.issues.join("|"));
    const count = await contractorCount();
    const error = await sqlError(apply(await forcedPlan(A)), "SI409", /requires review/);
    assert.equal(identityDetail(error).code, "identity_review_required");
    assert.deepEqual(identityDetail(error).matches.map((m) => m.contractor_id), [201]);
    assert.equal(await contractorCount(), count, "nothing committed");
  });

  await scenario("different-company review records a single-use decision; Import consumes it and audits", async () => {
    const saved = await save({ [A]: { action: "ADD", identityReview: { candidateIds: [201], reason: "  Different owner and FEIN  " } } });
    const review = saved.decisions.vendors[A].identityReview;
    assert.deepEqual(review.candidateIds, [201]);
    assert.equal(review.reason, "Different owner and FEIN");
    assert.match(review.decisionId, /^[0-9a-f-]{36}$/);
    assert.equal(review.approvedBy, ADMIN);
    const decision = await one("SELECT source,source_reference,reviewed_contractor_ids,decided_by,consumed_at FROM contractor_identity_decisions WHERE id=$1", [review.decisionId]);
    assert.deepEqual(decision, { source: "PROCORE", source_reference: `procore:${RUN}:${A}`, reviewed_contractor_ids: [201], decided_by: ADMIN, consumed_at: null });

    // Saving an unrelated vendor or the same review again keeps the recorded decision.
    const again = await save({ [A]: { action: "ADD", identityReview: { candidateIds: [201], reason: "Different owner and FEIN" } }, [B]: { action: "UNMATCHED" } });
    assert.deepEqual(again.decisions.vendors[A].identityReview, review);
    assert.equal((await one("SELECT count(*)::int n FROM contractor_identity_decisions")).n, 1);

    const p = await preview();
    assert.equal(vendor(p, A).identityStatus, "approved");
    const plan = p.ready.filter((x) => x.key === A);
    assert.equal(plan.length, 1);
    const result = await apply(plan);
    assert.equal(result.contractors_created, 1);
    const created = await one("SELECT id,creation_source FROM contractors WHERE company_name='Harborview Window Mfg.'");
    assert.equal(created.creation_source, "PROCORE");
    const consumed = await one("SELECT consumed_contractor_id FROM contractor_identity_decisions WHERE id=$1", [review.decisionId]);
    assert.equal(consumed.consumed_contractor_id, created.id);
    const audit = await one(`SELECT details FROM administration_audit_log WHERE action='PROCORE_SEPARATE_CONTRACTOR_CREATED' AND object_id=$1`, [RUN]);
    assert.deepEqual(audit.details.reviewed_contractor_ids, [201]);
    assert.equal(audit.details.identity_decision_id, review.decisionId);
    assert.equal(audit.details.contractor_id, created.id);
    assert.equal((await one("SELECT contractor_id FROM procore_vendor_mappings WHERE vendor_key=$1", [A])).contractor_id, created.id);
    assert.equal(vendor(await preview(), A).identityMatches, undefined, "now mapped: no longer an identity candidate");
  });

  await scenario("review becomes stale when a new possible match appears; preview and server both require re-review", async () => {
    await save({ [A]: { action: "ADD", identityReview: { candidateIds: [201], reason: "Different company" } } });
    await query("INSERT INTO contractors(id,company_name,active) VALUES(301,'Harborview Window Manufacturing',true)");
    const v = vendor(await preview(), A);
    assert.equal(v.identityStatus, "review_required");
    assert.ok(v.issues.some((i) => /out of date/.test(i)));
    const error = await sqlError(apply(await forcedPlan(A)), "SI409");
    assert.equal(identityDetail(error).code, "identity_review_stale");
    // Re-reviewing with the complete current list succeeds.
    const fresh = await save({ [A]: { action: "ADD", identityReview: { candidateIds: [201, 301], reason: "Different company" } } });
    assert.notEqual(fresh.decisions.vendors[A].identityReview.decisionId, undefined);
    assert.equal(vendor(await preview(), A).identityStatus, "approved");
  });

  await scenario("incomplete, foreign, forged, or malformed reviews are rejected", async () => {
    await query("INSERT INTO contractors(id,company_name,active) VALUES(302,'Harborview Window Manufacturing',true)");
    const stale = await sqlError(save({ [A]: { action: "ADD", identityReview: { candidateIds: [201], reason: "Different" } } }), "SI409");
    assert.equal(identityDetail(stale).code, "identity_review_stale");
    await sqlError(save({ [A]: { action: "ADD", identityReview: { candidateIds: [201, 302, 203], reason: "Different" } } }), "SI409");
    await sqlError(save({ [B]: { action: "ADD", identityReview: { candidateIds: [201], reason: "Different" } } }), "22023", /No possible existing contractor/);
    await sqlError(save({ [E]: { action: "ADD", identityReview: { candidateIds: [204], reason: "Different" } } }), "40001", /context changed/);
    for (const bad of [
      { candidateIds: [], reason: "Different" }, { candidateIds: [201], reason: "  x " }, { candidateIds: ["201"], reason: "Different" },
      { candidateIds: [0], reason: "Different" }, { candidateIds: [201.5], reason: "Different" }, { candidateIds: [201], reason: "y".repeat(1001) },
    ]) await sqlError(save({ [A]: { action: "ADD", identityReview: bad } }), "22023", /Invalid different-company review/);
    await sqlError(save({ [A]: { action: "MATCH", contractorId: 201, identityReview: { candidateIds: [201], reason: "Different" } } }), "22023");
    await sqlError(save({ [D]: { action: "ADD", identityReview: { candidateIds: [202], reason: "Different" },
      duplicateOverride: { contractorId: 202, companyName: "Exact Name Builders LLC" } } }), "22023", /Invalid Add Contractor review/);
    await sqlError(save({ [A]: { action: "ADD", identityReview: { candidateIds: [201, 302], reason: "Different" } } }, REVIEWER), "42501");

    // Tampered decisions (not recorded by save_review) cannot authorise creation.
    const tamper = (review) => query(`UPDATE procore_import_runs SET decisions=jsonb_set(decisions,ARRAY['vendors',$2],$3::jsonb) WHERE id=$1`,
      [RUN, A, JSON.stringify({ action: "ADD", identityReview: review })]);
    await tamper({ candidateIds: [201, 302], reason: "Different", decisionId: uuid(777), approvedBy: ADMIN, approvedAt: "2026-01-01" });
    assert.equal(identityDetail(await sqlError(apply(await forcedPlan(A)), "SI409")).code, "identity_review_stale");
    await tamper({ candidateIds: [201, 302], reason: "Different", decisionId: "not-a-uuid", approvedBy: ADMIN, approvedAt: "2026-01-01" });
    await sqlError(apply(await forcedPlan(A)), "40001", /stale or unverified/);
    // A decision recorded for a different vendor/candidate cannot be replayed onto this one.
    const other = await one(`SELECT contractor_identity_record_decision($1::jsonb,ARRAY[202],'Different',$2,'test') id`,
      [JSON.stringify({ source: "PROCORE", company_name: "Exact Name Builders, LLC", procore_vendor_key: D }), ADMIN]);
    await tamper({ candidateIds: [201, 302], reason: "Different", decisionId: other.id, approvedBy: ADMIN, approvedAt: "2026-01-01" });
    assert.equal(identityDetail(await sqlError(apply(await forcedPlan(A)), "SI409")).code, "identity_review_stale");
  });

  await scenario("exact-name plain ADD keeps the existing explicit-override requirement", async () => {
    await save({ [D]: { action: "ADD" } });
    assert.equal(vendor(await preview(), D).identityStatus, "review_required");
    await sqlError(apply(await forcedPlan(D)), "40001", /requires explicit duplicate-name override approval/);
  });

  await scenario("legacy exact-name override still imports when it covers the only possible match", async () => {
    await save({ [D]: { action: "ADD", duplicateOverride: { contractorId: 202, companyName: "Exact Name Builders LLC" } } });
    const p = await preview();
    assert.equal(vendor(p, D).identityStatus, "approved");
    const result = await apply(p.ready.filter((x) => x.key === D));
    assert.equal(result.contractors_created, 1);
    assert.equal(await auditCount("PROCORE_SEPARATE_CONTRACTOR_CREATED"), 1);
  });

  await scenario("legacy exact-name override no longer bypasses an additional variant match", async () => {
    await save({ [D]: { action: "ADD", duplicateOverride: { contractorId: 202, companyName: "Exact Name Builders LLC" } } });
    await query("INSERT INTO contractors(id,company_name,active) VALUES(303,'The Exact Name Builders Company',true)");
    const v = vendor(await preview(), D);
    assert.equal(v.identityStatus, "review_required");
    const error = await sqlError(apply(await forcedPlan(D)), "SI409", /requires review/);
    assert.deepEqual(identityDetail(error).matches.map((m) => m.contractor_id).sort(), [202, 303]);
  });

  await scenario("exact-name vendor can instead be approved through the identity review", async () => {
    await save({ [D]: { action: "ADD", identityReview: { candidateIds: [202], reason: "Same name, different company" } } });
    const p = await preview();
    assert.equal(vendor(p, D).identityStatus, "approved");
    assert.equal((await apply(p.ready.filter((x) => x.key === D))).contractors_created, 1);
  });

  await scenario("Accept Match and existing mappings are unaffected", async () => {
    await save({ [A]: { action: "MATCH", contractorId: 201 } });
    const p = await preview();
    assert.equal(vendor(p, A).contractorId, 201);
    const count = await contractorCount();
    const result = await apply(p.ready.filter((x) => [A, E].includes(x.key)));
    assert.equal(result.contractors_created, 0);
    assert.equal(await contractorCount(), count);
    assert.equal((await one("SELECT contractor_id FROM procore_vendor_mappings WHERE vendor_key=$1", [A])).contractor_id, 201);
    await save({ [E]: { action: "ADD" } });
    await sqlError(apply([{ ...vendor(await preview(), E), createContractor: true }].map((v) => ({
      key: v.key, company: v.company, createContractor: true, contacts: [], assignments: [] }))),
    "40001", /no existing vendor mapping/);
  });

  await scenario("known limitation: two new vendors in one file that are variants of each other roll back atomically", async () => {
    await save({ [Z1]: { action: "ADD" }, [Z2]: { action: "ADD" } });
    const p = await preview();
    assert.equal(vendor(p, Z1).identityStatus, "clear");
    assert.equal(vendor(p, Z2).identityStatus, "clear");
    const count = await contractorCount();
    const error = await sqlError(apply(p.ready.filter((x) => [Z1, Z2].includes(x.key))), "SI409");
    assert.equal(identityDetail(error).code, "identity_review_required");
    assert.equal(await contractorCount(), count, "first insert rolled back with the import");
    // Workaround: import one, then the other is reviewed against the new contractor.
    await save({ [Z2]: { action: "UNMATCHED" } });
    assert.equal((await apply((await preview()).ready.filter((x) => x.key === Z1))).contractors_created, 1);
    await save({ [Z2]: { action: "ADD" } });
    assert.equal(vendor(await preview(), Z2).identityStatus, "review_required");
  });

  await t.test("preview without identity input keeps the legacy behaviour exactly", async () => {
    const ref = await reference();
    const decisions = { vendors: { [A]: { action: "ADD" }, [D]: { action: "ADD" } } };
    const legacy = buildProcorePreview(ROWS, decisions, ref, []);
    assert.equal(vendor(legacy, A).identityStatus, undefined);
    assert.equal(legacy.ready.some((x) => x.key === A), true, "legacy rule only knew exact names");
    assert.equal(legacy.ready.some((x) => x.key === D), false);
    const blocked = buildProcorePreview(ROWS, decisions, ref, [], { [A]: [{ contractor_id: 9, company_name: "Bound", active: true,
      signals: ["procore_binding"], match_class: "source_binding", disposition: "use_existing", match_rank: 1 }] });
    assert.equal(vendor(blocked, A).identityStatus, "blocked");
    assert.equal(blocked.ready.some((x) => x.key === A), false);
    assert.ok(vendor(blocked, A).issues.some((i) => /cannot be created/.test(i)));
  });

  await t.test("rollback boundary: restoring the 20261113/20261117 bodies and dropping the helpers restores prior definitions", async () => {
    await db.exec("BEGIN");
    try {
      const restore = (file, name) => read("supabase", file).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
      await db.exec(restore("20261113_procore_contractor_match_override.sql", "procore_save_review"));
      await db.exec(restore("20261117_procore_import_source_lookup.sql", "procore_apply_import"));
      await db.exec("DROP FUNCTION public.procore_identity_matches(JSONB); DROP FUNCTION public.procore_identity_candidate(JSONB,TEXT);");
      assert.deepEqual(await one(definition(SAVE)), before.save);
      assert.deepEqual(await one(definition(APPLY)), before.apply);
    } finally { await db.exec("ROLLBACK"); }
  });
});
