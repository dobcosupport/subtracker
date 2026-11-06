import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHmac } from "node:crypto";

const require = createRequire(import.meta.url);
const { default: EmbeddedPostgres } = require("embedded-postgres");
const { Client } = require("pg");
assert(process.env.TEST_POSTGREST_BIN, "Set TEST_POSTGREST_BIN to an isolated PostgREST 14.5 executable");
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const port = async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return value;
};
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subtracker-procore-health-"));
const dbPort = await port(), restPort = await port();
const logs = [];
const cluster = new EmbeddedPostgres({
  databaseDir: path.join(directory, "db"), port: dbPort, user: "postgres", password: "isolated-fixture",
  persistent: true, autoRehydrateSymlinks: true, postgresFlags: ["-h", "127.0.0.1"],
  onLog: (message) => logs.push(String(message)), onError: (message) => logs.push(String(message)),
});
let db, rest, started = false;
const actor = "00000000-0000-0000-0000-000000000001";
const viewer = "00000000-0000-0000-0000-000000000002";
const secret = "isolated-procore-fixture-not-a-production-secret";
const payload = [JSON.stringify({ alg: "HS256", typ: "JWT" }), JSON.stringify({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 3600 })]
  .map((value) => Buffer.from(value).toString("base64url")).join(".");
const jwt = payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
try {
  await cluster.initialise();
  if (process.env.TEST_PG_CTL) {
    execFileSync(process.env.TEST_PG_CTL, ["-D", path.join(directory, "db"), "-l", path.join(directory, "postgres.log"),
      "-o", `-h 127.0.0.1 -p ${dbPort}`, "-w", "start"], { windowsHide: true, stdio: "ignore" });
  } else await cluster.start();
  started = true;
  db = new Client({ host: "127.0.0.1", port: dbPort, user: "postgres", password: "isolated-fixture", database: "postgres" });
  await db.connect();
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  await query("SET statement_timeout='100ms'");
  await assert.rejects(query("SELECT pg_sleep(0.5)"), /statement timeout/);
  await query("SET statement_timeout=0");
  await query(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE authenticator LOGIN PASSWORD 'isolated-fixture'; GRANT service_role,anon TO authenticator;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,name text,email text,system_administrator boolean);
    INSERT INTO user_profiles VALUES('${actor}','Administrator','Active','Fixture','fixture@example.invalid',true),
      ('${viewer}','Project Manager','Active','Viewer','viewer@example.invalid',false);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean);
    INSERT INTO role_permissions SELECT 'Project Manager',m,true,true,true,true FROM unnest(ARRAY['imports','projects','contractors'])m;
    CREATE TABLE contractors(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_name text,phone text,address_1 text,
      city text,state text,zip_code text,active boolean,creation_source text,creation_import_history_id integer);
    INSERT INTO contractors(company_name,active) VALUES('Isolated fixture',true);
    CREATE TABLE projects(id integer PRIMARY KEY,project_number text,project_name text);
    CREATE TABLE contractor_contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contractor_id integer,
      contact_name text,email text,mobile_phone text,is_active boolean DEFAULT true);
    CREATE FUNCTION save_contractor_contact(integer,uuid,jsonb) RETURNS contractor_contacts LANGUAGE sql AS
      $$SELECT * FROM contractor_contacts LIMIT 1$$;
    CREATE TABLE contractor_projects(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,contractor_id integer,
      project_id integer,active boolean DEFAULT true,ownership_sources text[] DEFAULT '{}',UNIQUE(contractor_id,project_id));
    CREATE TABLE import_history(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,file_name text,imported_rows integer,
      successful_rows integer,failed_rows integer,notes text);
    CREATE TABLE administration_audit_log(audit_date timestamptz DEFAULT now(),user_id uuid,user_name text,user_email text,action text,object_type text,
      object_id text,object_label text,details jsonb);
    CREATE FUNCTION contractor_import_name_key(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower($1)$$;
  `);
  for (const migration of ["20261110_procore_import_workflow.sql", "20261112_procore_project_mappings.sql",
    "20261113_procore_contractor_match_override.sql", "20261117_procore_import_source_lookup.sql"]) {
    await query(read("supabase/" + migration));
  }
  const identity = read("supabase/20261204_contractor_identity_procore.sql");
  const applyStart = identity.indexOf("CREATE OR REPLACE FUNCTION public.procore_apply_import(");
  await query(identity.slice(applyStart, identity.indexOf("$$;", applyStart) + 3));
  const migration = read("supabase/20261205_procore_operation_health.sql");
  await assert.rejects(query(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), /division by zero/);
  await query("ROLLBACK");
  assert.equal((await query("SELECT to_regclass('procore_import_operations') AS name"))[0].name, null);
  await query(migration);
  const body = (await query("SELECT pg_get_functiondef('procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure) AS body"))[0].body;
  assert(!body.includes("40001"), "Every explicitly identified permanent apply conflict is nonretryable");
  assert(body.includes("Import changed or is Finalized; reload before importing' USING ERRCODE='PT409'"));
  const saveBody = (await query("SELECT pg_get_functiondef('procore_save_review(uuid,integer,jsonb,uuid)'::regprocedure) AS body"))[0].body;
  assert(saveBody.includes("40001"), "Unrelated function handling is not broadly rewritten");
  assert(!/pg_(terminate|cancel)_backend/.test(migration), "No database process kill capability exists");
  assert.deepEqual((await query(`SELECT has_function_privilege('service_role',
    'procore_apply_import(uuid,integer,text,jsonb,uuid)','EXECUTE') AS direct,
    has_table_privilege('service_role','procore_import_operations','UPDATE') AS raw_update`))[0],
  { direct: false, raw_update: false });
  const rows = Array.from({ length: 5996 }, (_, index) => ({ row: index + 2, "Company (Vendor) > Name": "Isolated fixture" }));
  const run = (await query(`INSERT INTO procore_import_runs(file_name,created_by,revision,source_rows,decisions,imported_rows,status)
    VALUES('isolated.xlsx',$1,536,$2,'{"vendors":{"fixture":{"action":"MATCH","contractorId":1}}}','[2,3]','Partial') RETURNING id`,
  [actor, JSON.stringify(rows)]))[0].id;
  const secondRun = (await query("INSERT INTO procore_import_runs(file_name,created_by,source_rows) VALUES('other.xlsx',$1,'[{\"row\":2}]') RETURNING id", [actor]))[0].id;
  const fingerprint = async () => (await query(`SELECT revision,source_row_count,md5(source_rows::text) source,
    md5(decisions::text) decisions,md5(imported_rows::text) imported,finalized_at FROM procore_import_runs WHERE id=$1`, [run]))[0];
  const before = await fingerprint();
  const config = path.join(directory, "postgrest.conf");
  fs.writeFileSync(config, `db-uri = "postgresql://authenticator:isolated-fixture@127.0.0.1:${dbPort}/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${secret}"
server-host = "127.0.0.1"
server-port = ${restPort}
db-pool = 5
`);
  rest = spawn(process.env.TEST_POSTGREST_BIN, [config], { windowsHide: true });
  rest.stdout.on("data", (data) => logs.push(String(data))); rest.stderr.on("data", (data) => logs.push(String(data)));
  rest.on("error", (error) => logs.push(error.message));
  const base = `http://127.0.0.1:${restPort}`;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch (error) {
      if (rest.exitCode !== null) throw new Error(`PostgREST exited: ${error.message}`);
    }
    await sleep(100);
  }
  assert(ready, "Isolated PostgREST is responsive");
  const rpc = async (name, args) => {
    const response = await fetch(`${base}/rpc/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json(); return { status: response.status, data };
  };
  const begin = async (id = run, revision = 536) => {
    const result = await rpc("procore_begin_operation", { p_run: id, p_revision: revision, p_actor: actor });
    assert.equal(result.status, 200, JSON.stringify(result)); return result.data;
  };
  const execute = (id, target = run, revision = 536) => rpc("procore_execute_operation", {
    p_operation: id, p_run: target, p_revision: revision, p_token: "fixture", p_plan: [], p_actor: actor,
  });
  const health = async () => (await rpc("procore_operation_health", { p_actor: actor })).data;
  const stop = (id, who = actor) => rpc("procore_request_operation_stop", { p_operation: id, p_actor: who });
  assert.equal((await health()).state, "healthy");
  assert.equal((await rpc("procore_begin_operation", { p_run: run, p_revision: 535, p_actor: actor })).status, 409);
  const deniedHealth = await rpc("procore_operation_health", { p_actor: viewer });
  assert.equal(deniedHealth.status, 403, JSON.stringify(deniedHealth));
  const stale = await begin();
  await query("UPDATE procore_import_operations SET revision=535 WHERE id=$1", [stale]);
  const staleResult = await execute(stale, run, 535);
  assert.equal(staleResult.status, 200);
  assert.equal(staleResult.data.error.code, "PT409");
  assert.match(staleResult.data.error.message, /Import changed or is Finalized/);
  assert.equal((await health()).state, "attention");
  assert.deepEqual(await fingerprint(), before);
  const finalized = await begin(secondRun, 1);
  await query(`UPDATE procore_import_runs SET finalized_at=now(),finalized_by=$2,finalized_review='{}',closeout='{}' WHERE id=$1`, [secondRun, actor]);
  const finalizedResult = await execute(finalized, secondRun, 1);
  assert.equal(finalizedResult.data.error.code, "PT409");
  await query("UPDATE procore_import_runs SET finalized_at=null,finalized_by=null,finalized_review=null,closeout=null WHERE id=$1", [secondRun]);
  console.log("PASS: real PostgREST 14.5 stale/finalized requests each return once; migration atomicity, privileges, staging preserved");

  // Only this isolated database uses a slow synthetic apply to exercise concurrency,
  // rolled-back business writes and timeout delivery through actual PostgREST.
  await query(`CREATE SEQUENCE fixture_attempts;
    CREATE OR REPLACE FUNCTION procore_apply_import(p_run uuid,p_revision integer,p_token text,p_plan jsonb,p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      PERFORM nextval('fixture_attempts');
      UPDATE contractors SET phone='uncommitted fixture';
      IF p_token='fixture' THEN PERFORM pg_sleep(3); END IF;
      RETURN '{"fixture":true}'::jsonb;
    END; $$;`);
  const unrelated = new Client({ host: "127.0.0.1", port: dbPort, user: "postgres", password: "isolated-fixture", database: "postgres" });
  await unrelated.connect();
  const a = await begin(), b = await begin(secondRun, 1);
  assert.notEqual(a, b, "Each attempt has a unique durable Operation ID");
  const promiseA = execute(a).catch((error) => ({ transportError: error.message }));
  const promiseB = execute(b, secondRun, 1).catch((error) => ({ transportError: error.message }));
  const unrelatedRead = unrelated.query("SELECT pg_sleep(3), 'unrelated request completed'::text AS result");
  let status;
  for (let n = 0; n < 30; n++) { status = await health(); if (status.operations.some((o) => o.id === a && o.executing)) break; await sleep(50); }
  assert.equal(status.state, "running", JSON.stringify({ status, sessions: await query(`SELECT pid,application_name,state,query
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`),
    locks: await query("SELECT pid,locktype,classid,objid,objsubid,granted FROM pg_locks WHERE locktype='advisory'") }));
  assert.equal((await stop(a)).status, 409, "Normal running imports do not expose Cancel Import");
  await query("UPDATE procore_import_operations SET started_at=clock_timestamp()-interval '65 seconds' WHERE id=$1", [a]);
  status = await health();
  assert.equal(status.state, "abnormal");
  assert(status.operations.findIndex((o) => o.id === a) < status.operations.findIndex((o) => o.id === stale),
    "Outstanding operations precede newer finished history");
  assert(status.operations.find((o) => o.id === a).can_stop);
  assert(!status.operations.find((o) => o.id === b).can_stop);
  assert.equal((await stop(a, viewer)).status, 403);
  assert.equal((await stop("00000000-0000-0000-0000-000000000099")).status, 404);
  const request = await stop(a);
  assert.equal(request.status, 200, JSON.stringify(request));
  assert.equal((await stop(a)).data.alreadyRequested, true);
  assert.equal((await health()).state, "stopping");
  const resultA = await promiseA, resultB = await promiseB;
  assert.equal(resultA.data.error.code, "PCSTP");
  assert.equal(resultB.data.ok, true, "Another Procore operation completes normally");
  assert.equal((await unrelatedRead).rows[0].result, "unrelated request completed");
  await unrelated.end();
  assert.equal((await execute(a)).status, 409, "A stopped operation cannot replay");
  assert.equal((await query("SELECT count(*)::int n FROM administration_audit_log WHERE action='PROCORE_OPERATION_STOP_REQUESTED'"))[0].n, 1);
  const stopped = (await query("SELECT * FROM procore_import_operations WHERE id=$1", [a]))[0];
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.stop_requested_by, actor); assert(stopped.finished_at);
  assert.equal((await stop(a)).status, 409, "A finished operation cannot be stopped again");
  assert.deepEqual(await fingerprint(), before);
  console.log("PASS: authoritative Running/Abnormal/Stopping transitions; scoped cooperative stop; single audit; other operation unaffected");

  const isolation = await begin();
  const different = await rpc("procore_execute_operation", { p_operation: isolation, p_run: secondRun, p_revision: 536,
    p_token: "fixture", p_plan: [], p_actor: actor });
  assert.equal(different.status, 409, "Operation cannot be applied to another run");
  await query("UPDATE procore_import_operations SET status='failed' WHERE id=$1", [isolation]);
  await query("UPDATE contractors SET phone='committed fixture'");
  const attempts = async () => Number((await query("SELECT last_value FROM fixture_attempts"))[0].last_value);
  await query(`CREATE OR REPLACE FUNCTION procore_apply_import(p_run uuid,p_revision integer,p_token text,p_plan jsonb,p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql AS $$BEGIN PERFORM nextval('fixture_attempts');
    UPDATE contractors SET phone='must rollback';
    RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE='40001'; END;$$;`);
  const circuit = await begin(), count = await attempts(), failure = await execute(circuit);
  assert.equal(failure.data.error.code, "PT409"); assert.equal(await attempts(), count + 1);
  await sleep(250); assert.equal(await attempts(), count + 1, "PostgREST does not replay a caught serialization failure");
  assert.equal((await query("SELECT phone FROM contractors"))[0].phone, "committed fixture");

  await query(`CREATE OR REPLACE FUNCTION procore_apply_import(p_run uuid,p_revision integer,p_token text,p_plan jsonb,p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql AS $$BEGIN UPDATE contractors SET phone='must rollback'; PERFORM pg_sleep(4);
    RETURN jsonb_build_object('timeout',current_setting('statement_timeout')); END;$$;`);
  const configured = (await query(`SELECT proconfig FROM pg_proc WHERE oid='procore_execute_operation(uuid,uuid,integer,text,jsonb,uuid)'::regprocedure`))[0].proconfig;
  assert(configured.includes("statement_timeout=120s"));
  const reloads = logs.join("").split("Schema cache loaded in").length;
  await query("ALTER FUNCTION procore_execute_operation(uuid,uuid,integer,text,jsonb,uuid) SET statement_timeout='800ms'; NOTIFY pgrst,'reload schema'");
  for (let n = 0; n < 200 && logs.join("").split("Schema cache loaded in").length === reloads; n++) await sleep(50);
  assert(logs.join("").split("Schema cache loaded in").length > reloads, "New timeout schema cache is ready");
  const timeoutId = await begin(), startedAt = Date.now(), timeout = await execute(timeoutId);
  assert.equal(timeout.data.error?.code, "57014", JSON.stringify({ ...timeout, elapsed: Date.now() - startedAt }));
  assert(Date.now() - startedAt < 3000, "Actual PostgREST-hoisted timeout interrupted the slow query");
  assert.equal((await query("SELECT status FROM procore_import_operations WHERE id=$1", [timeoutId]))[0].status, "timed_out");
  assert.equal((await query("SELECT phone FROM contractors"))[0].phone, "committed fixture");
  assert.deepEqual(await fingerprint(), before);
  assert.equal((await health()).state, "attention");
  const stopAtTimeout = await begin();
  await query("UPDATE procore_import_operations SET started_at=clock_timestamp()-interval '65 seconds' WHERE id=$1", [stopAtTimeout]);
  const timeoutStopPromise = execute(stopAtTimeout);
  for (let n = 0; n < 20; n++) {
    if ((await health()).operations.some((operation) => operation.id === stopAtTimeout && operation.executing)) break;
    await sleep(20);
  }
  assert.equal((await stop(stopAtTimeout)).status, 200);
  assert.equal((await timeoutStopPromise).data.error.code, "PCSTP");
  assert.equal((await query("SELECT status FROM procore_import_operations WHERE id=$1", [stopAtTimeout]))[0].status, "stopped");
  assert.equal((await query("SELECT phone FROM contractors"))[0].phone, "committed fixture");
  await query(`CREATE OR REPLACE FUNCTION procore_apply_import(p_run uuid,p_revision integer,p_token text,p_plan jsonb,p_actor uuid) RETURNS jsonb
    LANGUAGE sql AS $$SELECT '{}'::jsonb$$;`);
  const success = await begin();
  assert.equal((await execute(success)).data.ok, true);
  assert.equal((await execute(success)).status, 409, "A successful operation cannot replay");
  assert.equal((await health()).state, "healthy");
  assert.deepEqual(await fingerprint(), before);
  console.log("PASS: circuit breaker executes once; real statement timeout rolls back; history retained; Healthy returns; 536/5996 fixture unchanged");
} catch (error) {
  console.error(logs.slice(-12).join("\n")); throw error;
} finally {
  if (rest && rest.exitCode === null) {
    rest.kill(); await new Promise((resolve) => rest.once("exit", resolve));
  }
  if (db) await db.end();
  if (started) {
    if (process.env.TEST_PG_CTL) execFileSync(process.env.TEST_PG_CTL,
      ["-D", path.join(directory, "db"), "-m", "fast", "-w", "stop"], { windowsHide: true, stdio: "ignore" });
    else await cluster.stop();
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
