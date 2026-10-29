"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone worker uses CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ALLOWED_EVENTS = new Set([
  "start",
  "stop",
  "test",
  "search",
  "error",
  "human_verification_required",
  "human_verification_completed",
  "request_processed",
  "no_match",
  "invalid_input",
  "identity_mismatch",
  "ambiguous_result",
  "website_error",
  "failed",
]);

function codeMetadata() {
  const files = ["worker.js", "health.js", "input.js", "runtime.js"].map((file) => path.join(__dirname, file));
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
  const instanceId = dependencies.instanceId || crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const state = { lifecycle: "starting", last_poll_at: null, current_request_key: null };
  let sequence = 0;
  let timer = null;
  let sending = null;
  const events = [];
  const acknowledgedTests = new Set();
  let leaseTimer = null;
  const setDeadline = dependencies.setTimeout || setTimeout;
  const clearDeadline = dependencies.clearTimeout || clearTimeout;
  const ownershipLost = dependencies.onLeaseLost || (() => {});
  function armLeaseDeadline() {
    clearDeadline(leaseTimer);
    leaseTimer = setDeadline(() => ownershipLost("Lease renewal deadline exceeded."), 80000);
    leaseTimer.unref?.();
  }

  function record(event, message, details = {}) {
    if (!ALLOWED_EVENTS.has(event)) return;
    if (events.length >= 100) {
      log({ event: "health_report_error", message: "Telemetry buffer full; oldest event dropped." });
      events.shift();
    }
    const wireDetails = { ...details };
    if (Object.prototype.hasOwnProperty.call(wireDetails, "request_id")) {
      wireDetails.request_key = wireDetails.request_id;
      delete wireDetails.request_id;
    }
    events.push({ event, message: sanitize(message).slice(0, 500), ...wireDetails });
    void flush();
  }

  async function flush() {
    if (sending) return sending;
    sending = (async () => {
      do {
        const event = events[0];
        const current = metadata();
        const payload = {
          worker_key: "nj-brc",
          instance_id: instanceId,
          started_at: startedAt,
          sequence: ++sequence,
          ...state,
          browser_connected: browserConnected(),
          loaded_hash: loaded.hash,
          current_hash: current.hash,
          file_modified_at: current.modified,
          ...(event || {}),
        };
        const response = await transport(
          `${config.baseUrl}/api/integrations/compliance-sync/worker-health`,
          {
            method: "POST",
            headers: {
              "x-subtracker-brc-key": config.workerKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response.ok) {
          if ([401, 403, 409].includes(response.status)) ownershipLost(`Worker health rejected: HTTP ${response.status}`);
          throw new Error(`Worker health report rejected: HTTP ${response.status}`);
        }
        const result = await response.json();
        if (result?.ok !== true) throw new Error("Worker health response did not confirm lease renewal.");
        armLeaseDeadline();
        if (event) events.shift();
        if (
          result.test_id &&
          payload.browser_connected &&
          ["ready", "busy", "human_verification_required"].includes(payload.lifecycle) &&
          !acknowledgedTests.has(result.test_id)
        ) {
          acknowledgedTests.add(result.test_id);
          events.push({
            event: "test",
            message: "Worker readiness test acknowledged.",
            test_id: result.test_id,
          });
        }
      } while (events.length);
      return true;
    })()
      .catch((error) => {
        log({ event: "health_report_error", message: sanitize(error) });
        return false;
      })
      .finally(() => {
        sending = null;
      });
    return sending;
  }

  return {
    instanceId,
    start() {
      armLeaseDeadline();
      timer = schedule(() => void flush(), config.heartbeatMs || 20000);
      record("start", "NJ BRC worker starting.");
    },
    ready() {
      state.lifecycle = "ready";
      state.current_request_key = null;
    },
    polled() {
      state.last_poll_at = new Date().toISOString();
      if (state.lifecycle === "website_error") {
        state.lifecycle = "ready";
        state.current_request_key = null;
      }
    },
    busy(requestId) {
      state.lifecycle = "busy";
      state.current_request_key = requestId;
    },
    humanVerificationRequired(requestId) {
      state.lifecycle = "human_verification_required";
      state.current_request_key = requestId;
      record("human_verification_required", "Manual website verification is required.", {
        request_key: requestId,
      });
    },
    humanVerificationCompleted(requestId) {
      state.lifecycle = "busy";
      record("human_verification_completed", "Manual website verification completed.", {
        request_key: requestId,
      });
    },
    idle() {
      state.lifecycle = "ready";
      state.current_request_key = null;
    },
    event(event, message, details = {}) {
      record(event, message, details);
    },
    search(requestId, resultStatus) {
      record("search", `Search completed: ${resultStatus}`, {
        request_key: requestId,
        result_status: resultStatus,
      });
    },
    error(message, requestId) {
      if (state.lifecycle !== "human_verification_required") {
        state.lifecycle = "website_error";
        state.current_request_key = requestId || null;
      }
      record("error", message, { request_key: requestId || null });
    },
    websiteError(message, requestId) {
      if (state.lifecycle !== "human_verification_required") {
        state.lifecycle = "website_error";
        state.current_request_key = requestId || null;
      }
      record("website_error", message, { request_key: requestId || null });
    },
    async stop() {
      unschedule(timer);
      clearDeadline(leaseTimer);
      state.lifecycle = "stopped";
      state.current_request_key = null;
      record("stop", "NJ BRC worker stopped.");
      await flush();
      clearDeadline(leaseTimer);
    },
    flush,
  };
}

module.exports = { createHealthMonitor, codeMetadata, ALLOWED_EVENTS };
