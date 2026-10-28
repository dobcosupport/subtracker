import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const isolatedRequire = createRequire(path.join(root, "worker", "nj-pwc", "package.json"));
const webpack = require("next/dist/compiled/webpack/webpack").webpack;
const { chromium } = isolatedRequire("playwright");
const fixtureDir = path.join(root, "scripts", "fixtures", "company-merge-ui");
const outputDir = path.join(root, ".next", "company-merge-ui-test");
const bundlePath = path.join(outputDir, "bundle.js");
const shellBundlePath = path.join(outputDir, "shell-bundle.js");
let checks = 0;
const check = (condition, message) => {
  checks += 1;
  assert.ok(condition, message);
};

const compileHarness = (entry, filename, aliases = {}) => new Promise((resolve, reject) => {
  webpack({
    mode: "development",
    devtool: false,
    entry: path.join(fixtureDir, entry),
    output: { path: outputDir, filename },
    resolve: {
      extensions: [".tsx", ".ts", ".js"],
      alias: {
        "next/link": path.join(fixtureDir, "link-shim.tsx"),
        ...aliases,
      },
    },
    module: {
      rules: [{
        test: /\.tsx?$/,
        use: [{ loader: path.join(fixtureDir, "tsx-loader.cjs") }],
      }],
    },
  }, (error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    resolve();
  });
});

const preview = {
  primary: { id: 7001, company_name: "Synthetic Primary", city: "North", state: "NJ", nj_pwc_number: "PWC-PRIMARY", nj_brc_number: "BRC-PRIMARY" },
  secondary: { id: 7002, company_name: "Synthetic Secondary", city: "South", state: "NJ", nj_pwc_number: "PWC-SECONDARY", nj_brc_number: "BRC-SECONDARY" },
  snapshot: "synthetic-preview-snapshot",
  fields: ["company_name", "city", "nj_pwc_number", "nj_brc_number"],
  counts: { projects: { primary: 2, secondary: 1 } },
  projects: { primary: 2, secondary: 1, shared: 1, union: 2 },
  compliance: [
    { compliance_type_id: 501, compliance_name: "NJ PWC", records: [{ id: 601, contractor_id: 7001, registration_number: "PWC-CURRENT", effective_date: "2026-01-01", expiration_date: "2026-12-31", registry_status: "Current" }] },
    { compliance_type_id: 502, compliance_name: "NJ BRC", records: [{ id: 602, contractor_id: 7002, registration_number: "BRC-CURRENT", effective_date: "2026-02-01", expiration_date: null, registry_status: "Current" }] },
  ],
  contacts: [
    { id: "00000000-0000-4000-8000-000000000001", contractor_id: 7001, contact_name: "Active Primary Contact", is_primary_contact: true, is_active: true },
    { id: "00000000-0000-4000-8000-000000000002", contractor_id: 7002, contact_name: "Inactive Contact", is_primary_contact: false, is_active: false },
  ],
  blockers: [],
};

const main = async () => {
  await compileHarness("mount.tsx", "bundle.js", {
    "@/lib/admin-client": path.join(fixtureDir, "admin-client-shim.ts"),
  });
  await compileHarness("mount-shell.tsx", "shell-bundle.js", {
    "@/lib/supabase": path.join(fixtureDir, "supabase-shim.ts"),
    "@/lib/permissions": path.join(root, "src", "lib", "permissions.ts"),
    "@/components/AppSidebar": path.join(root, "src", "components", "AppSidebar.tsx"),
    "next/navigation": path.join(fixtureDir, "navigation-shim.ts"),
    "next/image": path.join(fixtureDir, "image-shim.tsx"),
  });
  let browser;
  let server;
  let shellCanManage = true;
  const searchRequests = [];
  const previewRequests = [];
  const postBodies = [];
  let includePreviewBlocker = false;
  let releaseFirstPost;
  let notifyFirstPost;
  const firstPostGate = new Promise((resolve) => { releaseFirstPost = resolve; });
  const firstPostStarted = new Promise((resolve) => { notifyFirstPost = resolve; });

  try {
    server = http.createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
      } else if (request.url === "/bundle.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        fs.createReadStream(bundlePath).pipe(response);
      } else if (request.url === "/shell-bundle.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        fs.createReadStream(shellBundlePath).pipe(response);
      } else if (request.url.startsWith("/admin/company-merge")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html><body><div id="root"></div><script src="/shell-bundle.js"></script></body></html>');
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        await route.abort("blockedbyclient");
        return;
      }
      if (url.pathname === "/" || url.pathname === "/bundle.js" || url.pathname === "/admin/company-merge" || url.pathname === "/shell-bundle.js") {
        await route.continue();
        return;
      }
      if (url.pathname === "/api/admin/bootstrap") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      if (url.pathname === "/api/auth/session") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            profile: { auth_user_id: "synthetic-actor", name: "Synthetic Merge Operator", role: "Merge Operator", status: "Active", system_administrator: false },
            permissions: [{
              role: "Merge Operator",
              module: "company_merge",
              can_view: shellCanManage,
              can_manage: shellCanManage,
              can_add: false,
              can_edit: false,
              can_delete: false,
            }],
          }),
        });
        return;
      }
      if (url.pathname !== "/api/admin/company-merge") {
        await route.abort("blockedbyclient");
        return;
      }

      if (route.request().method() === "GET" && url.searchParams.has("search")) {
        searchRequests.push(url.searchParams.get("search"));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ candidates: [
            { id: 7001, company_name: "Synthetic Primary", city: "North", state: "NJ", active: true },
            { id: 7002, company_name: "Synthetic Secondary", city: "South", state: "NJ", active: false },
          ] }),
        });
        return;
      }
      if (route.request().method() === "GET" && url.searchParams.has("primary")) {
        previewRequests.push([url.searchParams.get("primary"), url.searchParams.get("secondary")]);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...preview,
          blockers: includePreviewBlocker
            ? [
              "An unfinished import explicitly selects a predecessor. Remove that decision or finalize the import first.",
              "Open sync review or exception. Resolve it through the existing workflow before merging.",
            ]
            : preview.blockers,
          blockerDetails: includePreviewBlocker ? [
            {
              blocker: "An unfinished import explicitly selects a predecessor. Remove that decision or finalize the import first.",
              company_id: 7002,
              company_name: "Synthetic Secondary",
              source: "Procore",
              record_type: "Unfinished Procore Import",
              record_id: "run-7002",
              status: "Review",
              reason: "Saved MATCH decision for synthetic vendor",
              context: "synthetic-procore.xlsx · Revision 4",
              resolution_label: "Open Imports → Procore",
              resolution_path: "/imports",
            },
            {
              blocker: "Open sync review or exception. Resolve it through the existing workflow before merging.",
              company_id: 7002,
              company_name: "ON Point Window Treatment Inc",
              source: "NJ PWC",
              record_type: "NJ PWC Sync Exception",
              record_id: 274,
              status: "open",
              reason: "Multiple Matches",
              context: "failure · Production record · 2 consecutive failures · 2 occurrences",
              resolution_label: "Open Compliance Sync → NJ PWC Sync Exceptions",
              resolution_path: "/admin/compliance-sync",
              resolution_actions: [
                { label: "Select Match", guidance: "Only select a candidate if you have evidence it is this contractor.", href: "/admin/compliance-sync" },
                { label: "Run Search Again", guidance: "Consider this after correcting company information or when a new search could return a different result.", href: "/admin/compliance-sync" },
                { label: "Resolve Exception", guidance: "Use when the search has been reviewed and no valid registration match should be assigned.", href: "/admin/compliance-sync" },
                { label: "Open Contractor", guidance: "Review or correct the contractor's company information before searching again.", href: "/contractors/7002" },
              ],
              nj_pwc: {
                search_request_id: 3888,
                sync_run_id: 135,
                searched_company_name: "ON POINT WINDOW TREATMENT INC",
                searched_city: "Brooklyn",
                searched_state: "NY",
                searched_zip_code: "11249",
                candidate_count: 32,
                selected_match: null,
              },
            },
          ] : [],
        }) });
        return;
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        postBodies.push(body);
        if (postBodies.length === 1) {
          notifyFirstPost();
          await firstPostGate;
        }
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "The company records changed after preview. Refresh and retry." }),
        });
        return;
      }
      await route.abort("blockedbyclient");
    });

    await page.goto(origin);
    await page.getByLabel("Search primary company by name or ID").fill("Synthetic");
    await page.getByRole("button", { name: "Search", exact: true }).nth(0).click();
    await page.getByRole("button", { name: /Synthetic Primary.*ID 7001/ }).click();
    await page.getByLabel("Search secondary company by name or ID").fill("Synthetic");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    check(await page.getByRole("button", { name: /Synthetic Primary.*ID 7001/ }).count() === 0,
      "the selected primary is excluded from secondary candidates");
    await page.getByRole("button", { name: /Synthetic Secondary.*ID 7002/ }).click();
    check(await page.getByText("Synthetic Primary", { exact: true }).count() === 1, "primary identity is selected");
    check(await page.getByText("Synthetic Secondary", { exact: true }).count() === 1, "secondary identity is selected distinctly");
    check(searchRequests.length === 2, "search executed through intercepted local API fixture");

    await page.getByRole("button", { name: "Load merge preview" }).click();
    await page.getByRole("heading", { name: "Scalar field choices" }).waitFor();
    check(previewRequests.length === 1 && previewRequests[0].join(",") === "7001,7002", "preview request uses distinct selected IDs");
    check(await page.locator('input[type="radio"][name="field-nj_pwc_number"]').first().isChecked(), "scalar source choices default to primary");
    check(await page.getByText(/Fallback only when no current New Jersey compliance record is selected/).count() === 2,
      "NJ PWC and BRC card fields are labeled as fallback values");
    check(await page.getByLabel("NJ PWC").inputValue() === "", "NJ PWC compliance record starts unselected");
    check(await page.getByLabel("NJ BRC").inputValue() === "", "NJ BRC compliance record starts unselected");
    check(await page.getByLabel(/Primary contact after merge/).inputValue() === "", "primary contact starts unselected");
    check(await page.getByLabel(/Primary contact after merge/).locator("option").count() === 2,
      "inactive contacts are excluded from primary-contact choices");
    check(await page.getByRole("button", { name: "Continue to final confirmation" }).isDisabled(),
      "merge cannot proceed before compliance and contact selections");
    check(postBodies.length === 0, "preview and choices cause no execute request");

    await page.getByLabel("NJ PWC").selectOption("601");
    await page.getByLabel("NJ BRC").selectOption("602");
    await page.getByLabel(/Primary contact after merge/).selectOption("00000000-0000-4000-8000-000000000001");
    await page.getByLabel(/I understand this merge is irreversible/).check();
    await page.getByRole("button", { name: "Continue to final confirmation" }).click();
    await page.getByRole("dialog").waitFor();
    check(postBodies.length === 0, "opening confirmation dialog does not execute the merge");

    await page.getByRole("button", { name: "Confirm and merge" }).click();
    await firstPostStarted;
    await page.getByRole("button", { name: "Merging…" }).waitFor();
    check(await page.getByRole("button", { name: "Merging…" }).isDisabled(), "execute button is disabled during submission");
    const disabledSubmitBounds = await page.getByRole("button", { name: "Merging…" }).boundingBox();
    await page.mouse.dblclick(disabledSubmitBounds.x + disabledSubmitBounds.width / 2, disabledSubmitBounds.y + disabledSubmitBounds.height / 2);
    check(postBodies.length === 1, "double submission is prevented while first request is pending");
    check(postBodies[0].compliance["501"] === 601 && postBodies[0].compliance["502"] === 602,
      "explicit compliance selections are submitted for every type");
    check(postBodies[0].primary_contact === "00000000-0000-4000-8000-000000000001",
      "the selected active primary contact is submitted");
    check(postBodies[0].choices.nj_pwc_number === "primary" && postBodies[0].choices.nj_brc_number === "primary",
      "NJ fallback field choices contain only source labels");
    const stableOperation = postBodies[0].operation;
    check(/^[0-9a-f-]{36}$/i.test(stableOperation), "execute operation ID is a UUID");
    releaseFirstPost();

    await page.getByRole("dialog").getByRole("alert").filter({ hasText: "changed after preview" }).waitFor();
    check(await page.getByRole("button", { name: "Retry same operation" }).count() === 1,
      "stale failure offers retry with the same operation");
    await page.getByRole("button", { name: "Retry same operation" }).click();
    await page.getByRole("dialog").getByRole("alert").filter({ hasText: "changed after preview" }).waitFor();
    check(postBodies.length === 2 && postBodies[1].operation === stableOperation,
      "retry reuses the stable operation UUID");
    check(postBodies[1].primary === 7001 && postBodies[1].secondary === 7002,
      "stale failure retry preserves selected identities");

    await page.getByRole("button", { name: "Discard retry and refresh preview" }).click();
    await page.getByRole("heading", { name: "Scalar field choices" }).waitFor();
    check(previewRequests.length === 2, "discarding stale retry fetches a fresh preview");
    check(await page.getByLabel("NJ PWC").inputValue() === "", "fresh preview resets explicit compliance selections");

    includePreviewBlocker = true;
    await page.getByRole("button", { name: "Load merge preview" }).click();
    await page.getByRole("heading", { name: "Scalar field choices" }).waitFor();
    const blockerAlert = page.getByRole("alert", { name: "Blocking merge issues" });
    await blockerAlert.getByText("Synthetic Secondary (#7002)").waitFor();
    check(await blockerAlert.getByText("Procore Unfinished Procore Import · ID: run-7002").isVisible(),
      "blocking preview identifies the source system, import run and affected company");
    check(await blockerAlert.getByText("Status: Review").isVisible(), "blocking preview shows source record status");
    check(await blockerAlert.getByText("Reason: Saved MATCH decision for synthetic vendor").isVisible(),
      "blocking preview explains the saved decision");
    check(await blockerAlert.getByRole("link", { name: "Open Imports → Procore" }).getAttribute("href") === "/imports",
      "blocking preview links to the existing resolution workflow");
    check(await blockerAlert.getByText("NJ PWC Sync Exception #274").isVisible(),
      "NJ PWC exception identifier is explicit");
    check(await blockerAlert.getByText("Search Request #3888").isVisible()
      && await blockerAlert.getByText("Sync Run #135").isVisible(),
      "NJ PWC search and sync run identifiers are prominent");
    check(await blockerAlert.getByText("Search: ON POINT WINDOW TREATMENT INC").isVisible()
      && await blockerAlert.getByText("Brooklyn, NY 11249").isVisible(),
      "NJ PWC diagnostics show searched company and location");
    check(await blockerAlert.getByText("Candidates returned: 32").isVisible()
      && await blockerAlert.getByText("Selected Match: None").isVisible(),
      "NJ PWC diagnostics show candidate count and unselected state");
    for (const action of ["Select Match", "Run Search Again", "Resolve Exception", "Open Contractor"]) {
      check(await blockerAlert.getByRole("link", { name: action }).isVisible(),
        `NJ PWC resolution guidance includes ${action}`);
    }
    check(await page.getByText("Information — External systems:").isVisible(),
      "nonblocking information is visibly distinguished from blocking issues");
    check(await page.getByRole("heading", { name: "Company details" }).count() === 1,
      "the read-only preview remains visible when an unfinished-import blocker is returned");
    await page.getByLabel("NJ PWC").selectOption("601");
    await page.getByLabel("NJ BRC").selectOption("602");
    await page.getByLabel(/Primary contact after merge/).selectOption("00000000-0000-4000-8000-000000000001");
    await page.getByLabel(/I understand this merge is irreversible/).check();
    check(await page.getByRole("button", { name: "Continue to final confirmation" }).isDisabled(),
      "the blocker prevents only the final merge action, not preview rendering");
    check(postBodies.length === 2, "previewing a blocked merge never invokes the execute API");

    const shellPage = await context.newPage();
    await shellPage.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/admin/bootstrap") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      if (url.pathname === "/api/auth/session") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            profile: { auth_user_id: "synthetic-actor", name: "Synthetic Merge Operator", role: "Merge Operator", status: "Active", system_administrator: false },
            permissions: [{
              role: "Merge Operator",
              module: "company_merge",
              can_view: shellCanManage,
              can_manage: shellCanManage,
              can_add: false,
              can_edit: false,
              can_delete: false,
            }],
          }),
        });
        return;
      }
      if (url.origin === origin) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await shellPage.goto(`${origin}/admin/company-merge`);
    await shellPage.getByTestId("company-merge-shell-child").waitFor();
    check(await shellPage.getByRole("link", { name: /Company Merge/ }).count() === 1,
      "AppShell routes authorized company_merge.manage users into page and Administration sidebar");
    check(await shellPage.getByText("Administration", { exact: true }).count() === 1,
      "AppSidebar groups Company Merge under Administration");
    shellCanManage = false;
    await shellPage.goto(`${origin}/admin/company-merge`);
    await shellPage.getByRole("heading", { name: "Access Denied" }).waitFor();
    check(await shellPage.getByTestId("company-merge-shell-child").count() === 0,
      "AppShell denies the route without the dedicated Manage permission");

    console.log(`Company Merge mounted React/Playwright synthetic UI: ${checks} behavioral assertions passed; AppShell route guard and sidebar included; all requests were locally intercepted.`);
  } finally {
    releaseFirstPost?.();
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
