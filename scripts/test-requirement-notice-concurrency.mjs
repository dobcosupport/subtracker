import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { default: EmbeddedPostgres } = require(process.env.EMBEDDED_POSTGRES_MODULE || "embedded-postgres");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subtracker-notice-concurrency-"));
const server = net.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const cluster = new EmbeddedPostgres({
  databaseDir: path.join(directory, "db"), port, user: "postgres", password: "isolated-notice-fixture",
  persistent: true, autoRehydrateSymlinks: true, postgresFlags: ["-h", "127.0.0.1"],
});
let started = false;
try {
  await cluster.initialise();
  if (process.env.TEST_PG_CTL) {
    execFileSync(process.env.TEST_PG_CTL, ["-D", path.join(directory, "db"), "-l", path.join(directory, "postgres.log"),
      "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { windowsHide: true, stdio: "ignore" });
  } else await cluster.start();
  started = true;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./test-requirement-notice-preview-db.mjs", import.meta.url))], {
    stdio: "inherit", env: { ...process.env, NOTICE_TEST_PG_URL: `postgresql://postgres:isolated-notice-fixture@127.0.0.1:${port}/postgres` },
  });
  assert.equal(result.status, 0, "Isolated real PostgreSQL notice test failed");
} finally {
  if (started) {
    if (process.env.TEST_PG_CTL) execFileSync(process.env.TEST_PG_CTL, ["-D", path.join(directory, "db"), "-m", "fast", "-w", "stop"], { windowsHide: true, stdio: "ignore" });
    else await cluster.stop();
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
