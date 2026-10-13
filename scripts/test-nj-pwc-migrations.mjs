import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase");
const sql = (name) => fs.readFileSync(path.join(root, name), "utf8");
const schema = sql("20261014_nj_pwc_registry_sync_schema.sql");
const functions = sql("20261014_nj_pwc_registry_sync_functions.sql");
const userTableDefinitions = sql("20260929_user_management.sql").split("INSERT INTO public.role_permissions")[0] + "\nCOMMIT;";
const roleTableDefinitions = sql("20260929_user_management_enhancements.sql").split("INSERT INTO public.role_permissions")[0] + "\nCOMMIT;";
const prerequisites = [
  "subtracker_schema.sql",
  "20260924_contractor_detail_enhancements.sql",
  "20261002_compliance_sync_admin.sql",
  "20261002_compliance_sync_rpa.sql",
  "20261002_synced_compliance_records.sql",
  "20261002_compliance_records_synced_status.sql",
  "20261002_nj_brc_rpa_mapping.sql",
  "20261002_nj_brc_test_mode.sql",
  "20261005_nj_pwc_search_requests.sql",
  "20261006_nj_pwc_schema_alignment.sql",
];
const requiredColumns = [
  "contractor_id", "company_name", "contractor_active", "compliance_record_id",
  "compliance_type_id", "compliance_name", "registration_number", "expiration_date",
  "days_remaining", "calculated_status",
];
const viewColumns = async (db) => (await db.query(`
  SELECT attname AS name, atttypid::text AS type, atttypmod AS modifier
  FROM pg_attribute
  WHERE attrelid = 'public.contractor_compliance_status'::regclass
    AND attnum > 0 AND NOT attisdropped ORDER BY attnum
`)).rows;
const identity = async (db) => (await db.query(`
  SELECT oid::text, relowner::text, relacl::text
  FROM pg_class WHERE oid = 'public.contractor_compliance_status'::regclass
`)).rows[0];
const fixtures = [
  { name: "repository 12-column view" },
  { name: "deployed 10-column view", columns: requiredColumns },
  { name: "reported complaince_record_id typo", columns: requiredColumns, typo: true },
  {
    name: "optional columns appended rather than inserted",
    columns: [...requiredColumns, "compliance_active", "compliance_current"],
  },
  { name: "no existing view", absent: true },
  { name: "unknown column fails atomically", unknown: true },
  { name: "conflicting typo fails atomically", conflicting: true },
];
let failures = 0;
for (const fixture of fixtures) {
  const db = await PGlite.create();
  try {
    // Application tables use repository DDL. Only the user/role table
    // definitions are needed; unrelated historical policies are excluded.
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULL::UUID $$;
    `);
    await db.exec(userTableDefinitions);
    await db.exec(roleTableDefinitions);
    for (const name of prerequisites) await db.exec(sql(name));

    const repositoryDefinition = (await db.query("SELECT pg_get_viewdef('public.contractor_compliance_status'::regclass, true) AS sql")).rows[0].sql.replace(/;\s*$/, "");
    if (fixture.columns) {
      await db.exec(`
        DROP VIEW public.contractor_compliance_status;
        CREATE VIEW public.contractor_compliance_status WITH (security_invoker = true) AS
        SELECT ${fixture.columns.map((name) => `status.${name}`).join(", ")}
        FROM (${repositoryDefinition}) AS status;
      `);
    }
    if (fixture.typo) await db.exec("ALTER VIEW public.contractor_compliance_status RENAME COLUMN compliance_record_id TO complaince_record_id");
    if (fixture.columns?.length === 10) {
      const recordColumn = fixture.typo ? "complaince_record_id" : "compliance_record_id";
      await assert.rejects(
        db.exec(`CREATE OR REPLACE VIEW public.contractor_compliance_status AS ${repositoryDefinition}`),
        new RegExp(`cannot change name of view column "${recordColumn}" to "compliance_active"`),
      );
    }
    if (fixture.unknown || fixture.conflicting) {
      const definition = (await db.query("SELECT pg_get_viewdef('public.contractor_compliance_status'::regclass, true) AS sql")).rows[0].sql.replace(/;\s*$/, "");
      const extra = fixture.unknown ? "unexpected_column" : "complaince_record_id";
      await db.exec(`CREATE OR REPLACE VIEW public.contractor_compliance_status AS SELECT status.*, 1 AS ${extra} FROM (${definition}) AS status`);
    }
    if (fixture.absent) await db.exec("DROP VIEW public.contractor_compliance_status");

    let beforeColumns;
    let beforeIdentity;
    if (!fixture.absent) {
      const recordColumn = fixture.typo ? "complaince_record_id" : "compliance_record_id";
      await db.exec(`
        GRANT SELECT ON public.contractor_compliance_status TO authenticated, service_role;
        CREATE VIEW public.migration_test_dependent AS
          SELECT ${recordColumn} AS record_id, calculated_status FROM public.contractor_compliance_status;
        CREATE VIEW public.migration_test_second_dependent AS SELECT * FROM public.migration_test_dependent;
      `);
      beforeColumns = await viewColumns(db);
      beforeIdentity = await identity(db);
    }

    if (fixture.unknown || fixture.conflicting) {
      await assert.rejects(db.exec(schema), fixture.unknown ? /Unsupported.*unexpected_column/ : /contains both/);
      await db.exec("ROLLBACK");
      assert.deepEqual(await viewColumns(db), beforeColumns);
      assert.deepEqual(await identity(db), beforeIdentity);
      assert.equal((await db.query("SELECT to_regclass('public.nj_pwc_sync_state') AS state")).rows[0].state, null);
      assert.equal((await db.query(`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='compliance_records' AND column_name='registry_status'
      `)).rows[0].n, 0);
      console.log(`ok - ${fixture.name}`);
      continue;
    }

    await db.exec(schema);
    await db.exec(functions);
    if (!fixture.absent) {
      assert.deepEqual(await viewColumns(db), beforeColumns.map((column) => ({
        ...column, name: column.name === "complaince_record_id" ? "compliance_record_id" : column.name,
      })));
      assert.deepEqual(await identity(db), beforeIdentity);
      await db.query("SELECT * FROM public.migration_test_second_dependent");
    }

    const contractorId = (await db.query("INSERT INTO contractors(company_name) VALUES ('Migration Test Co') RETURNING id")).rows[0].id;
    const typeId = (await db.query("SELECT id FROM compliance_types WHERE compliance_name='NJ PWC'")).rows[0].id;
    await db.query(`
      INSERT INTO compliance_records(contractor_id, compliance_type_id, registration_number, expiration_date, registry_status)
      VALUES ($1, $2, 'TEST-001', CURRENT_DATE + 365, 'Expired - Not Found in Registry')
    `, [contractorId, typeId]);
    assert.equal((await db.query("SELECT calculated_status FROM contractor_compliance_status WHERE contractor_id=$1", [contractorId])).rows[0].calculated_status, "Expired");
    assert.equal((await db.query("SELECT nj_pwc_record_snapshot(cr)->>'registry_status' AS status FROM compliance_records cr WHERE contractor_id=$1", [contractorId])).rows[0].status, "Expired - Not Found in Registry");
    assert.equal((await db.query("SELECT nj_pwc_record_snapshot(NULL::compliance_records) AS snapshot")).rows[0].snapshot, null);
    if (!fixture.absent) {
      assert.equal((await db.query("SELECT calculated_status FROM migration_test_second_dependent")).rows[0].calculated_status, "Expired");
    }
    await db.exec(schema);
    await db.exec(functions);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM compliance_records WHERE contractor_id=$1", [contractorId])).rows[0].n, 1);
    console.log(`ok - ${fixture.name}: schema, functions, dependents, permissions, rerun`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${fixture.name}: ${error.message}`);
  } finally {
    await db.close();
  }
}
if (failures) process.exitCode = 1;
else console.log(`All ${fixtures.length} migration scenarios passed.`);
