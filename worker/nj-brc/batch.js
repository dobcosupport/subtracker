"use strict";

function parseBatchId(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--batch"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args[1])) {
    throw new Error("Use --batch followed by a Prepared Verification Batch UUID.");
  }
  return args[1];
}

function batchError(message, code) {
  return Object.assign(new Error(message), { code });
}

function systemicResult(result) {
  return ["protection", "temporary_failure", "verification_timeout", "verification_unavailable",
    "verification_unrecognized", "navigation_failure", "browser_lost"].includes(result.classification);
}

async function runAttendedBatch({
  sessionId, instanceId, context, browser, control, processRequest, confirmOwnership,
  sleep, log, isStopping = () => false, healthMonitor, controlIntervalMs = 2000,
}) {
  let page;
  let lastControlAt = -Infinity;
  let session;
  let consecutiveSourceErrors = 0;
  const checkSession = async (force = false) => {
    if (isStopping()) throw batchError("Attended worker stopped; no submission will be replayed.", "batch_stopped");
    if (!browser.isConnected() || page?.isClosed()) throw batchError("Attended browser was closed or disconnected.", "browser_lost");
    if (force || Date.now() - lastControlAt >= controlIntervalMs) {
      const state = await control("status");
      if (!state?.session || state.session.id !== sessionId) throw batchError("Batch control returned invalid session.", "invalid_response");
      session = state.session;
      lastControlAt = Date.now();
    }
    return session;
  };
  const awaitRunning = async (force = false) => {
    let pausedAt = null;
    for (;;) {
      const current = await checkSession(force);
      force = false;
      if (current.status === "running") return pausedAt === null ? 0 : Date.now() - pausedAt;
      if (current.status === "stopped" || current.status === "completed") {
        throw batchError(`Verification batch ${current.status}; no source submission permitted.`, "batch_stopped");
      }
      if (!["prepared", "paused"].includes(current.status)) throw batchError("Batch status is not supported.", "invalid_response");
      pausedAt ??= Date.now();
      await sleep(controlIntervalMs);
    }
  };
  const beforeSourceAction = async (force = false) => {
    return awaitRunning(force);
  };
  try {
    await checkSession(true);
    if (session.status === "stopped" || session.status === "completed") return session;
    page = await context.newPage();
    log({ event: "batch_attended", message: `Batch ${sessionId}: waiting for Start attended session; one visible browser page.` });
    for (;;) {
      await awaitRunning();
      await confirmOwnership(instanceId);
      const next = await control("next");
      if (!next?.session || next.session.id !== sessionId) throw batchError("Batch next response is invalid.", "invalid_response");
      session = next.session;
      lastControlAt = Date.now();
      if (session.status === "completed" || session.status === "stopped") return session;
      if (session.status !== "running" || !next.request) {
        await sleep(controlIntervalMs);
        continue;
      }
      if (!next.member || next.member.request_id !== next.request.id || next.request.status !== "claimed") {
        throw batchError("Batch returned an uncertain request; refusing source replay.", "uncertain_processing");
      }
      log({ event: "batch_member_start", request_id: next.request.id,
        message: `Batch ${sessionId}: company ${next.member.ordinal} of ${session.member_count}.` });
      healthMonitor?.polled();
      const result = await processRequest(context, next.request, instanceId, {
        page, confirmOwnership, sleep, isStopping, healthMonitor, beforeSourceAction,
        onStateConflict: async () => {
          const current = await checkSession(true);
          if (current.status === "stopped" || current.status === "completed") {
            throw batchError("Batch stopped during a processing-state transition; no replay.", "batch_stopped");
          }
          return current.status === "paused";
        },
      });
      const saved = await control("complete", { request_id: next.request.id });
      if (!saved?.session || saved.session.id !== sessionId) throw batchError("Batch result completion was not confirmed.", "persistence_failure");
      session = saved.session;
      lastControlAt = Date.now();
      log({ event: "batch_member_saved", request_id: next.request.id, result_kind: result.kind,
        message: `Batch ${sessionId}: outcome persisted; successful certificates remain review-gated.` });
      consecutiveSourceErrors = result.kind === "website_error" ? consecutiveSourceErrors + 1 : 0;
      if (session.status === "stopped" || session.status === "completed") return session;
      if (systemicResult(result) || consecutiveSourceErrors >= 2) {
        await control("pause");
        lastControlAt = -Infinity;
        log({ event: "batch_paused", message: "NJ requires operator review before continuing the remaining batch." });
        consecutiveSourceErrors = 0;
      }
      healthMonitor?.idle();
    }
  } catch (error) {
    if (error.code === "batch_stopped") {
      if (isStopping() && !["stopped", "completed"].includes(session?.status)) {
        try { session = (await control("pause")).session; } catch (pauseError) {
          log({ event: "batch_pause_error", message: pauseError.message });
        }
      }
      log({ event: "batch_stopped", message: error.message });
      return session;
    }
    try {
      await control("pause");
      log({ event: "batch_paused", message: "Batch paused after a browser, ownership, or persistence failure; no source replay." });
    } catch (pauseError) {
      log({ event: "batch_pause_error", message: pauseError.message });
    }
    throw error;
  } finally {
    if (page && !page.isClosed()) await page.close();
  }
}

module.exports = { parseBatchId, systemicResult, runAttendedBatch };
