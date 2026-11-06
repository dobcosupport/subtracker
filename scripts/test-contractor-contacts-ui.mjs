import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Intercepted localhost preview only");
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "actor@example.invalid",
  aud: "authenticated", app_metadata: {}, user_metadata: {} };
const browser = await chromium.launch({ headless: true });
try {
  for (const testCase of ["no-contact", "contact", "dashboard-no-contact", "dashboard-contact", "contact-failure", "contact-response-lost", "duplicate", "no-manage", "pwc-retry"]) {
    const scenario = testCase.replace("dashboard-", "");
    const fromDashboard = testCase.startsWith("dashboard-");
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const contractors = [], contacts = [], errors = [], assignments = [], consoleErrors = [];
    let creates = 0, contactWrites = 0, pwcWrites = 0, directoryReads = 0, denyContact = scenario === "contact-failure";
    await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
      access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
    })), { storageKey, user });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(appUrl).origin) {
        if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
          profile: { auth_user_id: user.id, name: "Synthetic", status: "Active", system_administrator: false },
          permissions: ["dashboard", "contractors", "compliance", "insurance", "projects", "followups", "imports", "compliance_sync"].map(module =>
            ({ module, can_view: true, can_manage: scenario !== "no-manage", can_add: true, can_edit: true })),
        } });
        if (url.pathname === "/api/contractors" && request.method() === "POST") {
          creates++;
          if (scenario === "duplicate") return route.fulfill({ status: 409, json: { error: "Synthetic duplicate blocked" } });
          contractors.push({ id: 901, ...request.postDataJSON().contractor });
          return route.fulfill({ status: 201, json: { data: contractors } });
        }
        if (["/api/contractors/nj-pwc-search/latest", "/api/contractors/nj-pwc-search/11"].includes(url.pathname)) return route.fulfill({ json: {
          found: true, search_request_id: 11, status: "completed", candidates: [{
            business_name: "Synthetic Contact Contractor", certificate_number: "123456",
            expiration_date: "2099-01-01", address: "1 Main Street",
          }],
        } });
        if (url.pathname === "/api/contractors/nj-pwc-import") {
          pwcWrites++;
          return route.fulfill(pwcWrites === 1 ? { status: 500, json: { error: "Synthetic PWC failure" } }
            : { json: { ok: true, approval: "auto_approved", compliance_record_id: 51, message: "PWC completed." } });
        }
        if (url.pathname.startsWith("/api/")) {
          assert.ok(request.method() === "GET" || url.pathname === "/api/admin/bootstrap", `Unexpected API mutation ${url.pathname}`);
          return route.fulfill({ json: { records: [], contacts: [], policies: [], unlinks: [], rows: [] } });
        }
        return route.continue();
      }
      assert.equal(url.origin, origin, "No unrelated external requests");
      if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
      if (url.pathname.endsWith("/rpc/set_manual_project_assignment")) {
        const values = request.postDataJSON();
        assert.equal(values.p_contractor, 901);
        assert.equal(values.p_project, 71);
        assert.equal(values.p_owned, true);
        assignments.push(values);
        return route.fulfill({ json: [{ id: 1, contractor_id: 901, project_id: 71, active: true }] });
      }
      if (url.pathname.endsWith("/rpc/save_contractor_contact")) {
        contactWrites++;
        const { p_contractor_id, p_contact_id, p_values } = request.postDataJSON();
        assert.equal(p_contractor_id, 901);
        assert.equal(p_values.receives_compliance_sms, false);
        assert.equal(p_values.sms_consent_recorded, false);
        if (denyContact) return route.fulfill({ status: 403, json: { message: "Synthetic contact permission denied" } });
        const saved = { id: p_contact_id ?? "00000000-0000-0000-0000-000000000091",
          contractor_id: p_contractor_id, ...p_values };
        const index = contacts.findIndex(contact => contact.id === saved.id);
        if (index < 0) contacts.push(saved); else contacts[index] = saved;
        if (scenario === "contact-response-lost" && contactWrites === 1) {
          return route.fulfill({ status: 500, json: { message: "Synthetic response lost after contact save" } });
        }
        return route.fulfill({ json: saved });
      }
      assert.ok(["GET", "HEAD"].includes(request.method()), `No live mutations: ${request.method()} ${url.pathname}`);
      const table = url.pathname.split("/").at(-1);
      if (table === "contractors") {
        directoryReads++;
        return route.fulfill({ json: request.headers().accept?.includes("object") ? contractors[0] : contractors });
      }
      if (table === "contractor_contacts") return route.fulfill({ json: contacts });
      if (table === "projects") return route.fulfill({ json: [{
        id: 71, project_number: "26-071", project_name: "Synthetic Project", status: "Active",
      }] });
      return route.fulfill({ json: [] });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const expectedStatus = { duplicate: 409, "contact-failure": 403, "contact-response-lost": 500, "pwc-retry": 500 }[scenario];
      if (expectedStatus && message.text().startsWith(`Failed to load resource: the server responded with a status of ${expectedStatus}`)) return;
      consoleErrors.push(message.text());
    });
    const compact = async locator => {
      assert.deepEqual(await locator.evaluate(element => {
        const style = getComputedStyle(element);
        return { height: element.getBoundingClientRect().height, font: style.fontSize, radius: style.borderRadius };
      }), { height: 28, font: "12px", radius: "6px" }, await locator.getAttribute("class"));
    };
    const openFromDirectory = async () => {
      const add = page.getByRole("button", { name: "Add Contractor", exact: true });
      await compact(add);
      await add.click();
    };
    await page.goto(fromDashboard ? appUrl : `${appUrl}/contractors`);
    if (fromDashboard) {
      const add = page.getByRole("link", { name: "Add Contractor", exact: true });
      await compact(add);
      assert.equal(await add.evaluate(element => element.previousElementSibling.textContent), "Export");
      await add.click();
      await page.getByRole("heading", { name: "Add Contractor", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.has("add"), false, "entry parameter is consumed without repeating the workflow on refresh");
    } else await openFromDirectory();
    const modal = page.getByRole("heading", { name: "Add Contractor", exact: true }).locator("../..");
    assert.equal(await modal.evaluate(element => element.getBoundingClientRect().width), 960);
    for (const name of ["Close", "Search NJ PWC", "Cancel", "Save Contractor"]) {
      await compact(modal.getByRole("button", { name, exact: true }));
    }
    const companyCenter = await page.getByLabel("Company Name", { exact: true }).evaluate(element => {
      const rect = element.getBoundingClientRect(); return rect.y + rect.height / 2;
    });
    const searchCenter = await modal.getByRole("button", { name: "Search NJ PWC", exact: true }).evaluate(element => {
      const rect = element.getBoundingClientRect(); return rect.y + rect.height / 2;
    });
    assert.ok(Math.abs(companyCenter - searchCenter) <= 1, `Search NJ PWC aligns with Company Name input (${companyCenter} / ${searchCenter})`);
    if (testCase === "no-contact") {
      await modal.getByRole("button", { name: "Close", exact: true }).click();
      await openFromDirectory();
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await openFromDirectory();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await modal.evaluate(element => element.getBoundingClientRect().width), 342);
      await page.setViewportSize({ width: 1440, height: 1080 });
    }
    await page.getByLabel("Company Name", { exact: true }).fill("Synthetic Contact Contractor");
    const contactForm = page.getByRole("group", { name: "Contact Information (optional)", exact: true });
    if (scenario === "no-manage") assert.equal(await contactForm.count(), 0, "management permission is required for contact writes");
    else {
      assert.equal(await contactForm.evaluate(element => Boolean(element.compareDocumentPosition(
        [...element.parentElement.querySelectorAll("label")].find(label => label.textContent === "Assign Projects")
      ) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "Contact Information precedes Assign Projects");
      assert.equal(await contactForm.getByText(/SMS/).count(), 0);
      assert.equal(await contactForm.getByLabel("Primary Contact", { exact: true }).isChecked(), false);
      if (!["no-contact", "duplicate"].includes(scenario)) {
        await contactForm.getByLabel("Phone", { exact: true }).fill("201-555-0101");
        await page.getByRole("button", { name: "Save Contractor", exact: true }).click();
        await page.getByText("Enter a First Name or Last Name for the contact.", { exact: true }).waitFor();
        assert.equal(creates, 0, "invalid contact cannot leave a partial contractor");
        await contactForm.getByLabel("First Name", { exact: true }).fill("Ada");
        await contactForm.getByLabel("Last Name", { exact: true }).fill("Example");
        await contactForm.getByLabel("Title / Role", { exact: true }).fill("Office Manager");
        await contactForm.getByLabel("Email", { exact: true }).fill("ada@example.invalid");
        await contactForm.getByLabel("Primary Contact", { exact: true }).check();
        await contactForm.getByLabel("Receive Compliance Email", { exact: true }).check();
      }
    }
    if (scenario === "pwc-retry") {
      await page.getByRole("button", { name: "Search NJ PWC", exact: true }).click();
      const results = page.getByRole("heading", { name: "NJ PWC Registry Matches", exact: true }).locator("../..");
      await results.getByRole("button", { name: "Cancel", exact: true }).first().click();
      for (const name of ["Check Search Status", "Start New Search", "Continue Without NJ PWC Search"]) {
        await compact(modal.getByRole("button", { name, exact: true }));
      }
      await modal.getByRole("button", { name: "Check Search Status", exact: true }).click();
      await results.getByRole("button", { name: "Cancel", exact: true }).first().click();
      await modal.getByRole("button", { name: "Start New Search", exact: true }).click();
      await results.getByRole("button", { name: "Cancel", exact: true }).first().click();
      await modal.getByRole("button", { name: "Continue Without NJ PWC Search", exact: true }).click();
      assert.equal(await modal.getByRole("button", { name: "Check Search Status", exact: true }).count(), 0);
      await modal.getByRole("button", { name: "Search NJ PWC", exact: true }).click();
      await page.getByRole("button", { name: "Select Match", exact: true }).click();
      await page.getByRole("button", { name: "Import Selected Information", exact: true }).click();
    }
    await page.getByLabel("26-071 Synthetic Project", { exact: true }).check();
    await page.getByRole("button", { name: "Save Contractor", exact: true }).click();
    if (scenario === "duplicate") {
      await page.getByText("Synthetic duplicate blocked", { exact: true }).waitFor();
      assert.equal(contactWrites, 0);
    } else {
      if (["contact-failure", "contact-response-lost"].includes(scenario)) {
        await page.getByText(/Contractor created, but the contact could not be saved/).waitFor();
        assert.equal(creates, 1);
        assert.equal(await page.getByLabel("Company Name", { exact: true }).isDisabled(), true);
        assert.equal(await page.getByLabel("26-071 Synthetic Project", { exact: true }).isDisabled(), true);
        denyContact = false;
        await page.getByRole("button", { name: "Retry Contact Save", exact: true }).click();
      }
      let readsBeforeRetry;
      if (scenario === "pwc-retry") {
        await page.getByText(/Contractor (?:created, but PWC tracking failed|was saved, but NJ PWC tracking could not be created)/).waitFor();
        assert.equal(pwcWrites, 1, "Failure does not automatically retry");
        readsBeforeRetry = directoryReads;
        await page.getByRole("button", { name: "Retry NJ PWC Tracking", exact: true }).click();
        assert.equal(contactWrites, 1, "PWC retry cannot recreate the contact");
      }
      await page.getByRole("heading", { name: "Add Contractor", exact: true }).waitFor({ state: "hidden" });
      if (scenario === "pwc-retry") {
        assert.equal(pwcWrites, 2, "Exactly one explicit retry; no import replay");
        assert.equal(directoryReads, readsBeforeRetry + 1, "Retry refreshes the authoritative Contractors directory once");
        await page.locator("tbody tr").filter({ hasText: "Synthetic Contact Contractor" }).waitFor();
      }
      assert.equal(creates, 1);
      assert.equal(assignments.length, 1, "project assignment occurs once, including contact/PWC retries");
      assert.equal(await page.locator("table tr").evaluateAll(rows => rows.some(row =>
        [...row.childNodes].some(child => child.nodeType !== Node.ELEMENT_NODE || !["TD", "TH"].includes(child.nodeName))
      )), false, "table rows retain only valid table-cell children");
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const edit = page.getByRole("heading", { name: "Edit Contractor", exact: true }).locator("../..");
      assert.equal(await edit.evaluate(element => element.getBoundingClientRect().width), 576);
      await edit.getByRole("button", { name: "Close", exact: true }).click();
      if (scenario === "contact-response-lost") assert.equal(contactWrites, 1, "retry recognizes the saved contact instead of duplicating it");
      if (["no-contact", "no-manage"].includes(scenario)) assert.equal(contactWrites, 0);
      else {
        assert.equal(contacts.length, 1);
        const saved = contacts[0];
        assert.equal(saved.contact_name, "Ada Example");
        assert.equal(saved.title_or_role, "Office Manager");
        assert.equal(saved.email, "ada@example.invalid");
        assert.equal(saved.business_phone, "201-555-0101");
        assert.equal(saved.mobile_phone, null);
        assert.equal(saved.is_primary_contact, true);
        assert.equal(saved.receives_compliance_email, true);
        assert.equal(contractors[0].contact_name, null, "no duplicate legacy contractor contact structure");
        await page.goto(`${appUrl}/contractors/901`);
        await page.getByRole("heading", { name: "Synthetic Contact Contractor", exact: true }).waitFor();
        await page.getByRole("button", { name: "Contacts", exact: true }).click();
        await page.locator("summary").filter({ hasText: "Ada Example" }).click();
        await page.getByText("Office Manager", { exact: true }).waitFor();
        await page.getByText("201-555-0101", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Edit Contact", exact: true });
        assert.equal(await editor.getByText(/SMS|Consent|Compliance Contact/).count(), 0);
        assert.equal(await editor.getByLabel("Primary Contact", { exact: true }).isChecked(), true);
        assert.equal(await editor.getByLabel("Receive Compliance Email", { exact: true }).isChecked(), true);
        await editor.getByLabel("Business Phone", { exact: true }).fill("201-555-0199");
        await editor.getByLabel("Mobile Phone", { exact: true }).fill("201-555-0188");
        await editor.getByLabel("Receive Compliance Email", { exact: true }).uncheck();
        await editor.getByRole("button", { name: "Save Changes", exact: true }).click();
        await editor.waitFor({ state: "hidden" });
        assert.equal(contacts[0].business_phone, "201-555-0199");
        assert.equal(contacts[0].mobile_phone, "201-555-0188");
        assert.equal(contacts[0].receives_compliance_email, false);
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, [], "no unexpected console errors (synthetic failure responses are intentional)");
    console.log(`PASS: Add Contractor / existing contacts / compact layout: ${testCase}`);
    await context.close();
  }
} finally { await browser.close(); }
