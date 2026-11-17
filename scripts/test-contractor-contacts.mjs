import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
function load(file, supabase) {
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: loaded, exports: loaded.exports, require: () => ({ supabase }) });
  return loaded.exports;
}
const { emptyInitialContact: blank, initialContactInput: input } = load("src/lib/initial-contractor-contact.ts");

test("rail Contacts retains one mounted list and existing authorized Add/Edit/Deactivate form workflow", async () => {
  const React = require("react");
  const existing = { id: 21, contractor_id: 8, contact_name: "Existing Contact", email: "existing@example.invalid",
    title_or_role: null, business_phone: "201-555-0101", mobile_phone: null, is_active: true,
    is_primary_contact: true, is_compliance_contact: false, receives_compliance_email: true };
  let contacts = [existing], hookIndex = 0, expanded = false, canManage = true, changed = 0;
  const hooks = [], saves = [];
  const fakeReact = {
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = index === 0 ? contacts : index === 1 ? false : initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useCallback: fn => fn,
    useEffect() {},
  };
  const loaded = { exports: {} };
  const source = fs.readFileSync(new URL("../src/components/contractors/ContractorContactsSection.tsx", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: loaded, exports: loaded.exports, require(name) {
    if (name === "react") return fakeReact;
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@/components/style3/Style3Chevron") {
      const chevron = { exports: {} };
      vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../src/components/style3/Style3Chevron.tsx", import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
      }).outputText, { module: chevron, exports: chevron.exports, require });
      return chevron.exports;
    }
    if (name === "@/components/SessionContext") return { useSessionProfile: () => ({ system_administrator: canManage, permissions: [] }) };
    if (name === "@/services/contractorContacts") return {
      getContractorContacts: async () => ({ data: contacts, error: null }),
      createContractorContact: async (id, values) => {
        saves.push({ action: "create", id, values });
        const contact = { ...values, id: 22, contractor_id: id };
        contacts = [...contacts, contact];
        return { data: contact, error: null };
      },
      updateContractorContact: async (id, contactId, values) => {
        saves.push({ action: "update", id, contactId, values });
        contacts = contacts.map(contact => contact.id === contactId ? { ...contact, ...values } : contact);
        return { data: contacts.find(contact => contact.id === contactId), error: null };
      },
    };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  const render = () => {
    hookIndex = 0;
    return loaded.exports.default({ contractorId: 8, onContactsChanged: () => { changed++; },
      expanded, onExpandedChange: value => { expanded = value; } });
  };
  const elements = (tree, predicate) => !React.isValidElement(tree) ? [] : [
    ...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => elements(child, predicate)),
  ];
  const content = tree => !React.isValidElement(tree) ? String(tree ?? "")
    : tree.props["aria-hidden"] ? "" : React.Children.toArray(tree.props.children).map(content).join("");
  const button = (tree, name) => elements(tree, element => element.type === "button" && content(element) === name)[0];
  const list = tree => elements(tree, element => element.props.id === "contractor-contact-list")[0];
  let tree = render();
  assert.equal(list(tree).props.hidden, true);
  button(tree, "Contacts").props.onClick();
  tree = render();
  assert.equal(list(tree).props.hidden, false);
  button(tree, "+ Add Contact").props.onClick();
  tree = render();
  elements(tree, element => typeof element.type === "function" && element.props.label === "Contact Name")[0].props.onChange("New Contact");
  tree = render();
  await elements(tree, element => element.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(saves[0].action, "create");
  assert.equal(saves[0].id, 8);
  assert.equal(saves[0].values.contact_name, "New Contact");
  assert.equal(changed, 1);
  tree = render();
  button(tree, "Contacts").props.onClick();
  assert.equal(list(render()).props.hidden, true);
  button(render(), "Contacts").props.onClick();
  tree = render();
  assert.equal(elements(list(tree), element => element.type === "summary").length, 2, "Collapse/reopen retains updated records");
  button(tree, "Edit").props.onClick();
  tree = render();
  const field = label => elements(tree, element => typeof element.type === "function" && element.props.label === label)[0];
  assert.equal(field("Contact Name").props.value, existing.contact_name);
  field("Contact Name").props.onChange("Updated Contact");
  field("Active").props.onChange(false);
  tree = render();
  await elements(tree, element => element.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(saves[1].action, "update");
  assert.equal(saves[1].contactId, 21);
  assert.equal(saves[1].values.contact_name, "Updated Contact");
  assert.equal(saves[1].values.is_active, false);
  assert.equal(saves[1].values.is_primary_contact, false);
  assert.equal(changed, 2);
  canManage = false;
  tree = render();
  assert.equal(button(tree, "+ Add Contact"), undefined);
  assert.equal(button(tree, "Edit"), undefined);
});

test("primary contacts use bounded batched reads, active-primary rules and explicit read errors", async () => {
  const calls = [];
  let failure = false;
  const service = load("services/contractorContacts.ts", {
    from(table) {
      assert.equal(table, "contractor_contacts");
      const request = { filters: {} };
      calls.push(request);
      const query = {
        select(columns) { request.columns = columns; return query; },
        in(field, values) { request.ids = values; assert.equal(field, "contractor_id"); return query; },
        eq(field, value) { request.filters[field] = value; return query; },
        order(field) { assert.equal(field, "contractor_id"); return query; },
        then(resolve) { return Promise.resolve(failure
          ? { data: null, error: { message: "Synthetic primary read denied" } }
          : { data: request.ids.map(contractor_id => ({ contractor_id, contact_name: `Primary ${contractor_id}` })), error: null }).then(resolve); },
      };
      return query;
    },
  });
  assert.equal((await service.getPrimaryContactsForContractors([])).data.size, 0);
  assert.equal(calls.length, 0, "empty contractor list does not query contacts");
  const result = await service.getPrimaryContactsForContractors([...Array.from({ length: 205 }, (_, i) => i + 1), 1]);
  assert.equal(result.data.size, 205);
  assert.deepEqual(calls.map(call => call.ids.length), [100, 100, 5]);
  for (const call of calls) {
    assert.deepEqual(call.filters, { is_active: true, is_primary_contact: true });
    assert.equal(call.columns, "contractor_id,contact_name,email,business_phone,mobile_phone");
  }
  failure = true;
  const denied = await service.getPrimaryContactsForContractors([1]);
  assert.equal(denied.data, null);
  assert.equal(denied.error.message, "Synthetic primary read denied");
});

test("optional initial contact uses existing combined name and non-SMS phone fields", () => {
  assert.equal(input(blank), null);
  assert.equal(input({ ...blank, first_name: "  ", phone: " " }), null);
  assert.throws(() => input({ ...blank, phone: "201-555-0101" }), /First Name or Last Name/);
  assert.throws(() => input({ ...blank, first_name: "Ada", email: "invalid" }), /valid contact email/);
  const saved = input({ ...blank, first_name: " Ada ", last_name: " Example ", title_or_role: " Manager ",
    phone: " 201-555-0101 ", email: " ada@example.invalid ", is_primary_contact: true, receives_compliance_email: true });
  assert.equal(saved.contact_name, "Ada Example");
  assert.equal(saved.title_or_role, "Manager");
  assert.equal(saved.email, "ada@example.invalid");
  assert.equal(saved.business_phone, "201-555-0101");
  assert.equal(saved.mobile_phone, null, "normal phone must not be inferred to be mobile");
  assert.equal(saved.is_primary_contact, true);
  assert.equal(saved.receives_compliance_email, true);
  assert.equal(input({ ...blank, last_name: "Example" }).is_primary_contact, false, "first contact is not automatically primary");
  assert.ok(Object.keys(saved).every((key) => !key.includes("sms")));
});

test("authenticated contact RPC retains primary rules, phones and permissions without new schema", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE contractors(id integer PRIMARY KEY);
      INSERT INTO contractors VALUES(1),(2);
      CREATE FUNCTION user_has_module_permission(text,text) RETURNS boolean LANGUAGE sql AS
        $$ SELECT current_setting('fixture.manage',true) = 'true' $$;
      SELECT set_config('fixture.manage','true',false);
    `);
    await db.exec(fs.readFileSync(new URL("../supabase/20261023_contractor_contacts.sql", import.meta.url), "utf8"));
    const procore = fs.readFileSync(new URL("../supabase/20261110_procore_import_workflow.sql", import.meta.url), "utf8");
    await db.exec(procore.slice(0, procore.indexOf("CREATE TABLE public.procore_import_runs")) + "\nCOMMIT;");
    let columns, failure = false;
    const calls = [];
    const service = load("services/contractorContacts.ts", {
      from(table) {
        assert.equal(table, "contractor_contacts");
        const query = {
          select(value) { columns = value; return query; }, eq() { return query; }, order() { return query; },
          then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
        };
        return query;
      },
      async rpc(name, values) {
        assert.equal(name, "save_contractor_contact");
        calls.push(values);
        if (failure) return { data: null, error: { message: "Synthetic save failure" } };
        try {
          const result = await db.query("SELECT to_jsonb(save_contractor_contact($1,$2,$3)) contact",
            [values.p_contractor_id, values.p_contact_id, JSON.stringify(values.p_values)]);
          return { data: result.rows[0].contact, error: null };
        } catch (error) {
          return { data: null, error: { message: error.message } };
        }
      },
    });
    await db.exec("SET ROLE authenticated");
    const first = await service.createContractorContact(1, input({ ...blank, first_name: "Ada", last_name: "Example",
      email: "ada@example.invalid", phone: "201-555-0101", title_or_role: "Manager",
      is_primary_contact: true, receives_compliance_email: true }));
    assert.equal(first.error, null);
    assert.equal(first.data.contractor_id, 1);
    assert.equal(first.data.contact_name, "Ada Example");
    assert.equal(first.data.business_phone, "201-555-0101");
    assert.equal(first.data.title_or_role, "Manager");
    assert.equal(first.data.receives_compliance_email, true);
    const second = await service.createContractorContact(1, input({ ...blank, first_name: "Ben", is_primary_contact: true }));
    assert.equal(second.error, null);
    await db.exec("RESET ROLE");
    assert.equal((await db.query("SELECT count(*)::int n FROM contractor_contacts WHERE contractor_id=1 AND is_primary_contact")).rows[0].n, 1);
    assert.equal((await db.query("SELECT is_primary_contact FROM contractor_contacts WHERE id=$1", [first.data.id])).rows[0].is_primary_contact, false);
    await db.exec("SET ROLE authenticated");
    const edited = await service.updateContractorContact(1, first.data.id, {
      ...input({ ...blank, first_name: "Ada", phone: "201-555-0199" }), mobile_phone: "201-555-0188",
      is_active: false, is_primary_contact: true,
    });
    assert.equal(edited.error, null);
    assert.equal(edited.data.is_primary_contact, false);
    assert.equal(edited.data.mobile_phone, "201-555-0188");
    assert.equal(edited.data.business_phone, "201-555-0199");
    assert.match((await service.updateContractorContact(2, first.data.id, input({ ...blank, first_name: "Wrong Parent" }))).error.message, /not found/);
    await db.exec("SELECT set_config('fixture.manage','false',false)");
    assert.match((await service.createContractorContact(1, input({ ...blank, first_name: "Denied" }))).error.message, /management permission/);
    await service.getContractorContacts(1);
    assert.doesNotMatch(columns, /sms|\*/i, "normal reads have no legacy SMS dependency");
    for (const call of calls) {
      assert.equal(call.p_values.receives_compliance_sms, false);
      assert.equal(call.p_values.sms_consent_recorded, false);
      assert.equal(call.p_values.sms_consent_date, null);
      assert.equal(call.p_values.sms_consent_source_or_note, null);
    }
    failure = true;
    assert.equal((await service.createContractorContact(1, input({ ...blank, first_name: "Failure" }))).error.message, "Synthetic save failure");
  } finally { await db.close(); }
});
