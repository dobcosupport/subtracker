import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = await PGlite.create();
try {
  await db.exec("CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(fs.readFileSync(path.join(root, "supabase", "20261009_compliance_worker_health.sql"), "utf8"));
  await db.exec(fs.readFileSync(path.join(root, "supabase", "tests", "compliance_worker_health.sql"), "utf8"));
  console.log("PASS: isolated worker health migration, server-only permissions, sequence/instance guards, server receipt timestamps, diagnostics, 200-event retention, no compliance data");
} finally { await db.close(); }
