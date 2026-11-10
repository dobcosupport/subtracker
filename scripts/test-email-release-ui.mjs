import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const build = path.resolve(process.env.TEST_BUILD_DIR || root);
assert.ok(fs.existsSync(path.join(build, ".next", "BUILD_ID")), "Build the release before running browser gates.");

const portProbe = net.createServer();
portProbe.listen(0, "localhost");
await once(portProbe, "listening");
const address = portProbe.address();
assert.ok(address && typeof address === "object");
const port = address.port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));

const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "localhost", "--port", String(port)], {
  cwd: build, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
});
const stopped = once(server, "close");
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);

try {
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("Production preview did not become ready within 60 seconds.")), 60_000);
    function finish(error) {
      clearTimeout(timer);
      server.stdout.off("data", data);
      server.off("error", failure);
      server.off("exit", exit);
      if (error) reject(error); else resolve();
    }
    function data(chunk) {
      output = (output + chunk.toString()).slice(-16_384);
      if (/Ready in/.test(output)) finish();
    }
    function failure(error) { finish(error); }
    function exit(code, signal) { finish(new Error(`Production preview exited before readiness: ${code ?? signal}`)); }
    server.stdout.on("data", data);
    server.once("error", failure);
    server.once("exit", exit);
  });
  const app = `http://localhost:${port}`;
  const response = await fetch(`${app}/settings`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, "The isolated production preview must respond successfully.");
  await response.text();

  for (const script of [
    "test-communications-ui.mjs",
    "test-email-communications-ui.mjs",
    "test-communication-compose-ui.mjs",
    "test-style3-shell-ui.mjs",
  ]) {
    assert.equal(server.exitCode, null, "Production preview must remain running during browser gates.");
    console.log(`Running ${script} against the isolated production build.`);
    const child = spawn(process.execPath, [path.join(root, "scripts", script)], {
      cwd: root, env: { ...process.env, TEST_APP_URL: app }, stdio: "inherit",
    });
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0, `${script} failed (${code ?? signal}); release gate remains closed.`);
  }
  console.log("PASS: all four Email release browser gates passed against production rendering, without HMR or live sends.");
} finally {
  if (server.exitCode === null) server.kill();
  await stopped;
}
