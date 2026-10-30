import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MIGRATION = read("supabase", "20261203_contractor_identity_foundation.sql");

// Synthetic contractors that reproduce the real duplicate patterns without production data.
const SEED = `
  INSERT INTO contractors(id,company_name,phone,address_1,zip_code,nj_pwc_number,federal_tax_id,nj_brc_number,external_id,active) VALUES
   (101,'Harborview Window Manufacturing Corporation','(732) 555-0101','10 Harbor St','07001','700101',NULL,NULL,NULL,true),
   (102,'Crestline Landscape & Construction Corp.','732-555-0102','22 Crest Road, Suite 4','07002','700102',NULL,NULL,NULL,true),
   (103,'Allied Building Specialties','732.555.0103','3 Allied Ave','07003','700103',NULL,NULL,NULL,true),
   (104,'Seaboard Panel Corportation','7325550104','4 Seaboard Dr','07004','700104',NULL,NULL,NULL,true),
   (105,'Harbor Glass & Metal Installers, Inc','732 555 0105','5 Glass Ln','07005','700105',NULL,NULL,NULL,true),
   (106,'Mechanical Partners of New Jersey','732-555-0106','6 Mech Pl','07006','700106',NULL,NULL,NULL,true),
   (107,'Orion International Enterprises, LLC','732-555-0107','7 Orion Ct','07007','700107',NULL,NULL,NULL,true),
   (108,'The Dublin''s Overhead Door Company','732-555-0108','8 Door St','07008','700108',NULL,NULL,NULL,true),
   (109,'KLM Interior Solutions LLC','732-555-0109','9 Floor Street','07009','700109',NULL,NULL,NULL,true),
   (110,'Unrelated Shared Office Tenant','732-555-0110','100 Shared Plaza','07010',NULL,NULL,NULL,NULL,true),
   (111,'Another Shared Office Tenant','732-555-0111','100 Shared Plz Suite 200','07010',NULL,NULL,NULL,NULL,true),
   (112,'Phone Twin Holdings','732-555-0112','12 Twin Rd','07012',NULL,NULL,NULL,NULL,true),
   (113,'Federal Number Company','732-555-0113','13 Fed Rd','07013',NULL,'12-3456780','1234567890','EXT-113',true),
   (114,'Dormant Registry Holder','732-555-0114','14 Dormant Rd','07014','700114',NULL,NULL,NULL,false),
   (115,'Loading Ramp Inc.','732-555-0115','15 Ramp Rd','07015','700115',NULL,NULL,NULL,true),
   (116,'Loading Ramp, Inc.','732-555-0115','15 Ramp Rd','07015','700115',NULL,NULL,NULL,true),
   (117,'Merge Predecessor Co','732-555-0117','17 Old Rd','07017','700117',NULL,NULL,NULL,true),
   (118,'Merge Successor Co','732-555-0118','18 New Rd','07018','700118',NULL,NULL,NULL,true);
`;

test("contractor identity foundation (Phase 1, additive only)", async (t) => {
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
  const matches = async (candidate, exclude = null) =>
    query("SELECT * FROM contractor_identity_matches($1::jsonb,$2)", [JSON.stringify(candidate), exclude]);
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.contractor_id, r]));
  const sqlError = async (fn) => {
    try { await fn(); } catch (e) { return e; }
    assert.fail("expected an error");
  };
  const scenario = (name, fn) => t.test(name, async () => {
    await db.exec("BEGIN"); inScenario = true;
    try { await fn(); } finally { inScenario = false; await db.exec("ROLLBACK"); }
  });

  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT null::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_user::text$$;
  `);
  await db.exec(read("scripts", "fixtures", "company-merge-installed-schema.sql"));
  const nameKey = read("supabase", "20261104_mycoi_insurance_project_ownership.sql")
    .match(/CREATE FUNCTION public\.contractor_import_name_key[\s\S]*?\n\$\$;/)[0];
  await db.exec(nameKey);
  await db.exec(read("supabase", "20261121_company_merge.sql"));
  await db.exec(`
    INSERT INTO app_roles(role,is_system) VALUES('Administrator',true);
    INSERT INTO auth.users VALUES('${uuid(1)}'),('${uuid(2)}');
    INSERT INTO user_profiles(auth_user_id,name,email,role,system_administrator,status) VALUES
      ('${uuid(1)}','Synthetic Admin','admin@example.invalid','Administrator',true,'Active'),
      ('${uuid(2)}','Synthetic Inactive','inactive@example.invalid','Administrator',false,'Inactive');
    ${SEED}
    INSERT INTO import_history(id,file_name) VALUES(4001,'Synthetic Procore');
    INSERT INTO procore_import_runs(id,file_name,created_by,source_rows) VALUES('${uuid(50)}','Synthetic.xlsx','${uuid(1)}','[{"row":2}]');
    INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,accepted_by,import_run_id,import_history_id)
      VALUES('bound vendor','Bound Vendor',112,'${uuid(1)}','${uuid(50)}',4001);
    INSERT INTO mycoi_vendor_mappings(contractor_id,raw_vendor_name) VALUES(110,'MyCOI Bound Vendor');
  `);
  // Archive 117 into 118 the way Company Merge does (transaction-local authorization).
  await db.exec(`
    BEGIN;
    INSERT INTO company_merge_authorizations VALUES(pg_backend_pid(),txid_current(),'${uuid(99)}');
    UPDATE contractors SET active=false,merged_into_contractor_id=118 WHERE id=117;
    DELETE FROM company_merge_authorizations WHERE backend_pid=pg_backend_pid();
    COMMIT;
  `);

  const procSnapshot = `SELECT p.oid::regprocedure::text sig, md5(p.prosrc) src FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`;
  const triggerSnapshot = `SELECT tgrelid::regclass::text rel,tgname,tgfoid::regprocedure::text fn
    FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`;
  const rowSnapshot = "SELECT md5(string_agg(to_jsonb(c)::text,'|' ORDER BY id)) h FROM contractors c";
  const procsBefore = await query(procSnapshot);
  const triggersBefore = await query(triggerSnapshot);
  const rowsBefore = await one(rowSnapshot);
  const mergeFkBefore = await one(`SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND confrelid='public.contractors'::regclass`);

  await db.exec(MIGRATION);

  await t.test("migration is additive: no existing function, trigger, FK target, or contractor row changes", async () => {
    const procsAfter = await query(procSnapshot);
    const after = new Map(procsAfter.map((p) => [p.sig, p.src]));
    for (const p of procsBefore) assert.equal(after.get(p.sig), p.src, `existing function changed: ${p.sig}`);
    const added = procsAfter.filter((p) => !procsBefore.some((b) => b.sig === p.sig)).map((p) => p.sig);
    assert.ok(added.length > 0 && added.every((s) => s.startsWith("contractor_identity_")), added.join(","));
    assert.deepEqual(await query(triggerSnapshot), triggersBefore);
    assert.equal((await one(rowSnapshot)).h, rowsBefore.h);
    const fkAfter = await one(`SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND confrelid='public.contractors'::regclass`);
    assert.equal(fkAfter.n, mergeFkBefore.n, "new tables must not reference contractors");
    assert.doesNotMatch(MIGRATION, /CREATE\s+OR\s+REPLACE|CREATE\s+TRIGGER|DROP\s|ALTER\s+TABLE\s+public\.contractors\s|(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(public\.)?contractors\s/i);
  });

  await t.test("Company Merge preview still recognises every contractor dependency", async () => {
    const r = await one("SELECT company_merge_preview(101,103,$1) result", [uuid(1)]);
    assert.ok(!JSON.stringify(r.result).includes("Unrecognized contractor dependency"), JSON.stringify(r.result));
  });

  await t.test("normalizers", async () => {
    const k = async (sql, args) => (await one(`SELECT ${sql} v`, args)).v;
    assert.equal(await k("contractor_identity_pwc_key($1)", [" 60-970 "]), "60970");
    assert.equal(await k("contractor_identity_pwc_key($1)", [" "]), null);
    assert.equal(await k("contractor_identity_phone_key($1)", ["+1 (732) 555-0101 ext. 22"]), "7325550101");
    assert.equal(await k("contractor_identity_phone_key($1)", ["732-555-0101 / 908-555-0102"]), null);
    assert.equal(await k("contractor_identity_phone_key($1)", ["000-000-0000"]), null);
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["22 Crest Road, Suite 4", "7002"]), "22 crest rd 07002");
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["100 Shared Plaza", "07010-1234"]), "100 shared plz 07010");
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["P.O. Box 12", "07010"]), "po box 12 07010");
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["9 Floor Street", "07009"]), "9 floor st 07009");
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["9 Main St 2nd Floor", "07009"]), "9 main st 07009");
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["9 Main St #B-12", "07009"]), "9 main st 07009");
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["Main Street", "07010"]), null);
    assert.equal(await k("contractor_identity_address_key($1,$2)", ["1 Main St", null]), null);
    assert.equal(await k("contractor_identity_fein_key($1)", ["12-3456780"]), "123456780");
    assert.equal(await k("contractor_identity_fein_key($1)", ["00-0000000"]), null);
    const v = (s) => k("contractor_identity_name_variant_key($1)", [s]);
    assert.equal(await v("Harborview Window Mfg."), await v("Harborview Window Manufacturing Corporation"));
    assert.equal(await v("Crestline Landscape & Const. Corp"), await v("Crestline Landscape & Construction Corp."));
    assert.equal(await v("ALLIED BLDG SPECIALITIES"), await v("Allied Building Specialties"));
    assert.equal(await v("Seaboard Panel Corporation"), await v("Seaboard Panel Corportation"));
    assert.equal(await v("Harbor Glass & Metal Installer"), await v("Harbor Glass & Metal Installers, Inc"));
    assert.equal(await v("Mechanical Partners of NJ"), await v("Mechanical Partners of New Jersey"));
    assert.equal(await v("Orion International Enterp."), await v("Orion International Enterprises, LLC"));
    assert.equal(await v("Dublin's Overhead Door"), await v("The Dublin's Overhead Door Company"));
    assert.equal(await v("Pro Drywall Constr."), await v("Pro Drywall Construction Inc."));
    assert.equal(await v("Acme (formerly Beta Corp) Glass"), await v("Acme Glass"));
    assert.notEqual(await v("KLM Flooring LLC"), await v("KLM Interior Solutions LLC"));
    assert.notEqual(await v("Glass Co"), await v("Gas Co"));
    assert.equal(await v("&"), "and");
  });

  await t.test("the seven Procore duplicate patterns are found without similarity scoring", async () => {
    const cases = [
      [{ company_name: "Harborview Window Mfg.", phone: "732-555-0101", address_1: "10 Harbor Street", zip_code: "07001" }, 101, "strong_possible"],
      [{ company_name: "Crestline Landscape & Const. Corp", phone: "7325550102", address_1: "22 Crest Rd", zip_code: "07002" }, 102, "strong_possible"],
      [{ company_name: "ALLIED BLDG SPECIALITIES", address_1: "3 Allied Avenue", zip_code: "07003" }, 103, "strong_possible"],
      [{ company_name: "Seaboard Panel Corporation", phone: "732-555-0104", address_1: "4 Seaboard Drive", zip_code: "07004" }, 104, "strong_possible"],
      [{ company_name: "Harbor Glass & Metal Installer", address_1: "5 Glass Lane", zip_code: "07005" }, 105, "strong_possible"],
      [{ company_name: "Mechanical Partners of NJ", phone: "732-555-0106", address_1: "6 Mech Place", zip_code: "07006" }, 106, "strong_possible"],
      [{ company_name: "KLM Flooring LLC", address_1: "9 Floor St", zip_code: "07009" }, 109, "informational"],
      [{ company_name: "Orion International Enterp." }, 107, "possible"],
      [{ company_name: "Dublin's Overhead Door" }, 108, "possible"],
    ];
    for (const [candidate, id, expected] of cases) {
      const found = byId(await matches({ source: "PROCORE", ...candidate }));
      assert.equal(found[id]?.match_class, expected, `${candidate.company_name}: ${JSON.stringify(found)}`);
    }
  });

  await t.test("tier and disposition rules", async () => {
    let m = byId(await matches({ company_name: "Totally New Name", nj_pwc_number: "700-101" }));
    assert.equal(m[101].match_class, "pwc"); assert.equal(m[101].disposition, "hard_block");
    m = byId(await matches({ company_name: "Totally New Name", nj_pwc_number: "700114" }));
    assert.equal(m[114].match_class, "pwc_review", "inactive holder is review, not a hard block");
    assert.equal(m[114].disposition, "review_required");
    m = byId(await matches({ company_name: "Loading Ramp LLC" }));
    assert.equal(m[115].match_class, "exact_name"); assert.deepEqual(m[115].signals, ["exact_name"]);
    assert.equal(m[116].match_class, "exact_name");
    m = byId(await matches({ company_name: "Different", federal_tax_id: "123456780" }));
    assert.equal(m[113].match_class, "high_confidence"); assert.equal(m[113].disposition, "review_required");
    m = byId(await matches({ company_name: "Different", nj_brc_number: "1234567890" }));
    assert.equal(m[113].match_class, "high_confidence");
    m = byId(await matches({ company_name: "Nothing Alike", phone: "732-555-0112" }));
    assert.equal(m[112].match_class, "informational"); assert.equal(m[112].disposition, "informational");
    m = byId(await matches({ company_name: "Nothing Alike", address_1: "100 Shared Plaza", zip_code: "07010" }));
    assert.equal(m[110].disposition, "informational"); assert.equal(m[111].disposition, "informational");
    m = byId(await matches({ company_name: "Nothing Alike", phone: "732-555-0110", address_1: "100 Shared Plaza", zip_code: "07010" }));
    assert.equal(m[110].disposition, "informational", "phone + address without an identity signal stays informational");
    assert.deepEqual(m[110].signals, ["address", "phone"]);
    m = byId(await matches({ company_name: "Different", external_id: " ext-113 " }));
    assert.equal(m[113].disposition, "use_existing");
    m = byId(await matches({ source: "PROCORE", company_name: "Bound Vendor, Inc." }));
    assert.equal(m[112].match_class, "source_binding"); assert.deepEqual(m[112].signals, ["procore_binding"]);
    m = byId(await matches({ source: "MYCOI", company_name: " mycoi bound vendor " }));
    assert.equal(m[110].match_class, "source_binding");
    m = byId(await matches({ company_name: "Bound Vendor, Inc." }));
    assert.equal(m[112], undefined, "Procore binding applies only to Procore candidates");
    assert.equal((await matches({ company_name: "Loading Ramp" }, 115)).some((r) => r.contractor_id === 115), false);
  });

  await t.test("merged predecessors are never returned; matches resolve to the successor", async () => {
    const rows = await matches({ company_name: "Merge Predecessor Co", nj_pwc_number: "700117" });
    assert.equal(rows.some((r) => r.contractor_id === 117), false);
    const s = byId(rows)[118];
    assert.deepEqual(s.via_merged_contractor_ids, [117]);
    assert.equal(s.match_class, "pwc_review", "predecessor-only PWC is review, not a hard block");
    assert.equal((await query("SELECT * FROM contractor_identity_pwc_owners('700117',NULL)")).length, 0);
  });

  await t.test("batch matcher keys results per candidate", async () => {
    const rows = await query("SELECT candidate_key,contractor_id,match_class FROM contractor_identity_match_batch($1::jsonb)",
      [JSON.stringify([{ candidate_key: "a", company_name: "Harborview Window Mfg." }, { candidate_key: "b", company_name: "Unique Nobody" }])]);
    assert.deepEqual(rows, [{ candidate_key: "a", contractor_id: 101, match_class: "possible" }]);
  });

  await scenario("creation gate: hard block and source binding can never be overridden", async () => {
    const e = await sqlError(() => one("SELECT contractor_identity_assert_creatable($1::jsonb,NULL)",
      [JSON.stringify({ source: "PROCORE", company_name: "Brand New", nj_pwc_number: "700101" })]));
    assert.equal(e.code, "SI409");
    assert.equal(JSON.parse(e.detail).code, "identity_conflict");
    assert.equal(JSON.parse(e.detail).matches[0].contractor_id, 101);
    const d = await sqlError(() => one("SELECT contractor_identity_record_decision($1::jsonb,ARRAY[101],'Different company',$2)",
      [JSON.stringify({ source: "PROCORE", company_name: "Brand New", nj_pwc_number: "700101" }), uuid(1)]));
    assert.equal(d.code, "SI409");
    const b = await sqlError(() => one("SELECT contractor_identity_assert_creatable($1::jsonb,NULL)",
      [JSON.stringify({ source: "PROCORE", company_name: "Bound Vendor" })]));
    assert.equal(JSON.parse(b.detail).code, "identity_conflict");
  });

  await scenario("creation gate: review requires a current, unused decision; informational never blocks", async () => {
    const informational = { source: "PROCORE", company_name: "Nothing Alike", phone: "732-555-0112", address_1: "100 Shared Plaza", zip_code: "07010" };
    const ok = (await one("SELECT contractor_identity_assert_creatable($1::jsonb,NULL) r", [JSON.stringify(informational)])).r;
    assert.equal(ok.status, "creatable");
    assert.deepEqual(ok.matches.map((m) => m.disposition), ["informational", "informational", "informational"]);
    assert.equal((await one("SELECT contractor_identity_assert_creatable('{\"source\":\"MANUAL\",\"company_name\":\"Unique Nobody\"}',NULL) r")).r.status, "creatable");

    const candidate = { source: "PROCORE", company_name: "Harborview Window Mfg.", phone: "732-555-0101" };
    const e = await sqlError(() => one("SELECT contractor_identity_assert_creatable($1::jsonb,NULL)", [JSON.stringify(candidate)]));
    assert.equal(JSON.parse(e.detail).code, "identity_review_required");
    assert.equal(JSON.parse(e.detail).candidate.has_federal_tax_id, undefined);

    const incomplete = await sqlError(() => one("SELECT contractor_identity_record_decision($1::jsonb,ARRAY[999],'Different company',$2)",
      [JSON.stringify(candidate), uuid(1)]));
    assert.equal(JSON.parse(incomplete.detail).code, "identity_review_stale");
    const inactive = await sqlError(() => one("SELECT contractor_identity_record_decision($1::jsonb,ARRAY[101],'Different company',$2)",
      [JSON.stringify(candidate), uuid(2)]));
    assert.equal(inactive.code, "42501");

    const { id } = await one("SELECT contractor_identity_record_decision($1::jsonb,ARRAY[101],'Confirmed different company by phone',$2,'run-1') id",
      [JSON.stringify(candidate), uuid(1)]);
    const pass = (await one("SELECT contractor_identity_assert_creatable($1::jsonb,$2) r", [JSON.stringify(candidate), id])).r;
    assert.equal(pass.decision_id, id);

    const changed = await sqlError(() => one("SELECT contractor_identity_assert_creatable($1::jsonb,$2)",
      [JSON.stringify({ ...candidate, phone: "732-555-0999" }), id]));
    assert.equal(JSON.parse(changed.detail).code, "identity_review_stale", "changed identity data invalidates the decision");
    const wrongSource = await sqlError(() => one("SELECT contractor_identity_assert_creatable($1::jsonb,$2)",
      [JSON.stringify({ ...candidate, source: "MANUAL" }), id]));
    assert.equal(JSON.parse(wrongSource.detail).code, "identity_review_stale");

    await query("INSERT INTO contractors(id,company_name) VALUES(150,'Harborview Window Manufacturing LLC')");
    const stale = await sqlError(() => one("SELECT contractor_identity_assert_creatable($1::jsonb,$2)", [JSON.stringify(candidate), id]));
    assert.equal(JSON.parse(stale.detail).code, "identity_review_stale", "a newly appearing candidate requires a new review");
    await query("DELETE FROM contractors WHERE id=150");

    await query("SELECT contractor_identity_consume_decision($1,101)", [id]);
    const reused = await sqlError(() => one("SELECT contractor_identity_assert_creatable($1::jsonb,$2)", [JSON.stringify(candidate), id]));
    assert.equal(JSON.parse(reused.detail).code, "identity_review_stale");
    assert.equal((await sqlError(() => query("SELECT contractor_identity_consume_decision($1,101)", [id]))).code, "SI409");
  });

  await scenario("PWC owners and live conflict report; resolution needs no identity-table update", async () => {
    assert.deepEqual((await query("SELECT contractor_id FROM contractor_identity_pwc_owners('700-115',NULL)")).map((r) => r.contractor_id), [115, 116]);
    assert.deepEqual((await query("SELECT contractor_id FROM contractor_identity_pwc_owners('700115',115)")).map((r) => r.contractor_id), [116]);
    assert.equal((await query("SELECT * FROM contractor_identity_pwc_owners('700114',NULL)")).length, 0, "inactive holder is not an owner");
    let report = (await one("SELECT contractor_identity_conflict_report() r")).r;
    assert.deepEqual(report.pwc_conflicts.map((c) => [c.nj_pwc_number, c.contractors.map((x) => x.contractor_id)]), [["700115", [115, 116]]]);

    await query("SELECT contractor_identity_record_conflict('PWC_ASSIGNMENT','NJ_PWC_IMPORT',ARRAY[101],103,'700101','{}'::jsonb,'req-1',$1)", [uuid(1)]);
    report = (await one("SELECT contractor_identity_conflict_report() r")).r;
    assert.equal(report.recorded_conflicts.length, 1);
    await query("UPDATE contractors SET nj_pwc_number=NULL WHERE id=101");
    report = (await one("SELECT contractor_identity_conflict_report() r")).r;
    assert.equal(report.recorded_conflicts.length, 0, "correcting the registration resolves the attempt");

    const { id } = await one("SELECT contractor_identity_record_conflict('CREATION','PROCORE',ARRAY[102],NULL,NULL,$1::jsonb) id",
      [JSON.stringify({ company_name: "X", federal_tax_id: "12-3456780" })]);
    const stored = await one("SELECT candidate_summary FROM contractor_identity_conflicts WHERE id=$1", [id]);
    assert.equal(JSON.stringify(stored.candidate_summary).includes("3456780"), false, "FEIN is never stored");
    await query("SELECT contractor_identity_dismiss_conflict($1,$2,'Reviewed: different company')", [id, uuid(1)]);
    assert.equal((await one("SELECT contractor_identity_conflict_report() r")).r.recorded_conflicts.length, 0);
  });

  await t.test("only service_role can execute; tables are not exposed to API roles", async () => {
    const fns = await query(`SELECT p.oid::regprocedure::text sig,
        has_function_privilege('anon',p.oid,'EXECUTE') anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') auth
      FROM pg_proc p WHERE p.proname LIKE 'contractor_identity_%'`);
    for (const f of fns) assert.ok(!f.anon && !f.auth, f.sig);
    assert.equal((await one("SELECT has_function_privilege('service_role','contractor_identity_assert_creatable(jsonb,uuid)','EXECUTE') v")).v, true);
    for (const table of ["contractor_name_token_aliases", "contractor_identity_decisions", "contractor_identity_conflicts"]) {
      for (const role of ["anon", "authenticated"]) {
        assert.equal((await one(`SELECT has_table_privilege('${role}','${table}','SELECT') v`)).v, false, `${role} ${table}`);
      }
      assert.equal((await one(`SELECT has_table_privilege('service_role','${table}','INSERT') v`)).v, false);
    }
  });

  await db.close();
});
