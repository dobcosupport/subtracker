"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- The standalone worker package is CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function codeMetadata() {
  const files = [path.join(__dirname, "worker.js"), __filename];
  const hash = crypto.createHash("sha256");
  let modified = 0;
  for (const file of files) {
    hash.update(fs.readFileSync(file));
    modified = Math.max(modified, fs.statSync(file).mtimeMs);
  }
  return { hash: hash.digest("hex"), modified: new Date(modified).toISOString() };
}

function createHealthMonitor(config, browserConnected, log, sanitize, dependencies = {}) {
  const metadata = dependencies.metadata || codeMetadata;
  const transport = dependencies.fetch || fetch;
  const schedule = dependencies.setInterval || setInterval;
  const unschedule = dependencies.clearInterval || clearInterval;
  const loaded = metadata();
  const instance = crypto.randomUUID();
  const started = new Date().toISOString();
  const state = { lifecycle: "starting", last_poll_at: null, current_request_id: null };
  let sequence = 0;
  let timer = null;
  let sending = null;
  const events = [];

  function record(event, message, details = {}) {
    if (events.length >= 100) {
      log({ event: "health_report_error", message: "Telemetry event buffer full; oldest event dropped." });
      events.shift();
    }
    events.push({ event, message: sanitize(message).slice(0, 1000), ...details });
    void flush();
  }

  async function flush() {
    if (sending) return sending;
    sending = (async () => {
      do {
        const event = events[0];
        const current = metadata();
        const payload = {
          worker_key: "nj-pwc", instance_id: instance, started_at: started, sequence: ++sequence,
          ...state, browser_connected: browserConnected(),
          loaded_hash: loaded.hash, current_hash: current.hash, file_modified_at: current.modified,
          ...(event || {}),
        };
        const response = await transport(`${config.baseUrl}/api/integrations/compliance-sync/worker-health`, {
          method: "POST",
          headers: { "x-subtracker-rpa-key": config.rpaKey, "Content-Type": "application/json" },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`Worker health report rejected: HTTP ${response.status}`);
        const result = await response.json();
        if (event) events.shift();
        if (result.test_id && payload.browser_connected && ["ready", "busy"].includes(payload.lifecycle)
          && !events.some((item) => item.test_id === result.test_id)) {
          events.push({ event: "test", message: "Worker readiness test acknowledged.", test_id: result.test_id });
        }
      } while (events.length);
    })().catch((error) => {
      log({ event: "health_report_error", message: sanitize(error).slice(0, 1000) });
    }).finally(() => { sending = null; });
    return sending;
  }

  return {
    start() {
      timer = schedule(() => { void flush(); }, 15000);
      record("start", "Worker starting.");
    },
    ready() { state.lifecycle = "ready"; },
    polled() { state.last_poll_at = new Date().toISOString(); },
    busy(requestId) { state.lifecycle = "busy"; state.current_request_id = requestId; },
    idle() { state.lifecycle = "ready"; state.current_request_id = null; },
    search(requestId, resultStatus) {
      record("search", `Search completed: ${resultStatus}`, { request_id: requestId, result_status: resultStatus });
    },
    error(message, requestId) { record("error", message, { request_id: requestId ?? null }); },
    async stop() {
      unschedule(timer);
      state.lifecycle = "stopped";
      state.current_request_id = null;
      record("stop", "Worker stopped.");
      await flush();
    },
    flush,
  };
}

module.exports = { createHealthMonitor, codeMetadata };
