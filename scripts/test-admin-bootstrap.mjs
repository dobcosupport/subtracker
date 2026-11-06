import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const db = new PGlite();
try {
  await db.exec(`CREATE TABLE role_permissions (
    role text, module text, can_view boolean NOT NULL, can_manage boolean NOT NULL,
    can_add boolean NOT NULL, can_edit boolean NOT NULL, can_delete boolean NOT NULL,
    PRIMARY KEY(role,module));
    INSERT INTO role_permissions VALUES ('Existing Role','company_merge',false,false,false,false,false),
      ('Existing Role','contractors',true,false,false,false,false);`);
  const constraint = read("supabase/20261121_company_merge.sql")
    .match(/ALTER TABLE public\.role_permissions ADD CONSTRAINT role_permissions_check1 CHECK \([\s\S]*?END\);/);
  assert(constraint, "Use the existing production Company Merge constraint unchanged");
  await db.exec(constraint[0]);
  await assert.rejects(db.query(`INSERT INTO role_permissions
    VALUES ('Administrator','company_merge',true,true,true,true,true)`),
  (error) => error.code === "23514", "The old bootstrap values reproduce the established constraint failure");
  const profiles = new Map(), audits = [], authUpdates = [];
  let authUser, invitations = 0, seedCalls = 0, failPermissions = false;
  const admin = {
    auth: { admin: {
      listUsers: async () => ({ data: { users: [authUser] }, error: null }),
      inviteUserByEmail: async () => { invitations++; throw Error("Unexpected invitation"); },
      updateUserById: async (id, values) => { authUpdates.push({ id, values }); return { error: null }; },
    } },
    from(table) {
      let payload, filter;
      const query = {
        select() { return query; },
        eq(key, value) { filter = [key, value]; return query; },
        upsert(values, options) {
          assert.equal(options.onConflict, table === "user_profiles" ? "auth_user_id" : "role,module");
          payload = values; return query;
        },
        maybeSingle: async () => ({ data: [...profiles.values()].find((profile) => profile[filter[0]] === filter[1]) ?? null, error: null }),
        single: async () => {
          profiles.set(payload.auth_user_id, { ...profiles.get(payload.auth_user_id), ...payload });
          return { data: profiles.get(payload.auth_user_id), error: null };
        },
        async then(resolve, reject) {
          try {
            assert.equal(table, "role_permissions");
            seedCalls++;
            if (failPermissions) return resolve({ error: { code: "23514", message: "Synthetic constraint rejection" } });
            await db.transaction(async (tx) => {
              for (const permission of payload) {
                await tx.query(`INSERT INTO role_permissions VALUES ($1,$2,$3,$4,$5,$6,$7)
                  ON CONFLICT(role,module) DO UPDATE SET can_view=excluded.can_view,can_manage=excluded.can_manage,
                    can_add=excluded.can_add,can_edit=excluded.can_edit,can_delete=excluded.can_delete`,
                ["role", "module", "can_view", "can_manage", "can_add", "can_edit", "can_delete"].map((key) => permission[key]));
              }
            });
            resolve({ error: null });
          } catch (error) { reject(error); }
        },
      };
      return query;
    },
  };
  const modules = {};
  const types = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read("types/user-management.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: types.exports });
  modules["@/types/user-management"] = types.exports;
  modules["@/lib/server-admin"] = {
    createAdminClient: () => admin,
    getInviteRedirect: () => "http://localhost/invite",
    writeAdministrationAudit: async (...args) => audits.push(args),
    jsonError: (error) => Response.json({ error: error.message }, { status: 500 }),
  };
  const mod = { exports: {} };
  const sandbox = vm.createContext({ exports: mod.exports, Request, Response, console,
    require: (id) => { assert(Object.hasOwn(modules, id), `Unexpected dependency ${id}`); return modules[id]; } });
  vm.runInContext(ts.transpileModule(read("src/app/api/admin/bootstrap/route.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  const identity = vm.runInContext("SYSTEM_ADMIN", sandbox);
  authUser = { id: "00000000-0000-0000-0000-000000000001", email: identity.email,
    user_metadata: { existing_preference: "preserved" }, last_sign_in_at: "2026-01-01T00:00:00Z" };
  profiles.set("other", { auth_user_id: "other", name: "Existing user", role: "Existing Role", status: "Active" });
  const otherProfile = JSON.stringify(profiles.get("other"));
  const otherPermissions = (await db.query("SELECT * FROM role_permissions ORDER BY module")).rows;
  const request = () => new Request("http://localhost/api/admin/bootstrap", { method: "POST" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await mod.exports.POST(request());
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  assert.equal(invitations, 0);
  assert.equal(audits.length, 1, "Only initial protection is audited; repeated valid initialization adds no duplicate audit");
  assert.equal(profiles.size, 2, "Repeated initialization does not duplicate users");
  assert.equal(JSON.stringify(profiles.get("other")), otherProfile);
  assert.deepEqual((await db.query("SELECT * FROM role_permissions WHERE role='Existing Role' ORDER BY module")).rows, otherPermissions);
  const permissions = (await db.query("SELECT * FROM role_permissions WHERE role='Administrator'")).rows;
  assert.equal(permissions.length, types.exports.APP_MODULES.length);
  for (const permission of permissions) {
    assert.equal(permission.can_view, true);
    assert.equal(permission.can_manage, true);
    for (const key of ["can_add", "can_edit", "can_delete"]) assert.equal(permission[key], permission.module !== "company_merge");
  }
  assert(authUpdates.every(({ values }) => values.user_metadata.existing_preference === "preserved"));
  const profile = profiles.get(authUser.id);
  assert.equal(profile.last_login, authUser.last_sign_in_at);
  assert.equal(profile.invitation_count, 0);
  failPermissions = true;
  const before = seedCalls;
  assert.equal((await mod.exports.POST(request())).status, 500);
  assert.equal(seedCalls, before + 1, "A database failure surfaces once without an automatic retry");
  console.log("PASS: actual bootstrap handler succeeds repeatedly against unchanged Company Merge constraint; correct flags, existing users/roles/metadata preserved; no duplicate invitation/audit or retry loop");
} finally { await db.close(); }
