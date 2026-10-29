"use strict";

function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))
    || Number(raw) < minimum || Number(raw) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(raw);
}

function timingConfig(env) {
  const normal = integerSetting(env, "POLL_INTERVAL_SECONDS", 30, 5, 120) * 1000;
  const idleMax = integerSetting(env, "IDLE_MAX_SECONDS", 300, 30, 900) * 1000;
  const errorMax = integerSetting(env, "ERROR_MAX_SECONDS", 120, 30, 900) * 1000;
  if (idleMax < normal || errorMax < normal) throw new Error("Backoff caps must not be below the normal polling interval.");
  return {
    normal, idleMax, errorMax,
    heartbeat: integerSetting(env, "HEARTBEAT_SECONDS", 20, 5, 25) * 1000,
    resultWait: integerSetting(env, "RESULT_WAIT_SECONDS", 30, 1, 120) * 1000,
    shutdown: integerSetting(env, "SHUTDOWN_GRACE_SECONDS", 30, 1, 120) * 1000,
    resultAttempts: integerSetting(env, "RESULT_REPORT_ATTEMPTS", 3, 1, 5),
  };
}

function createBackoff(config) {
  let idle = config.normal;
  let error = config.normal;
  return {
    work() { idle = config.normal; error = config.normal; },
    empty() { const delay = idle; idle = Math.min(config.idleMax, idle * 2); error = config.normal; return delay; },
    error() { const delay = error; error = Math.min(config.errorMax, error * 2); return delay; },
  };
}

async function retryTransient(action, { attempts, sleep, onRetry = () => {} }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await action(); } catch (error) {
      if (!error.retryable || attempt + 1 >= attempts) throw error;
      const delay = Math.min(8000, 1000 * (2 ** attempt));
      onRetry(attempt + 1, delay);
      await sleep(delay);
    }
  }
}

module.exports = { integerSetting, timingConfig, createBackoff, retryTransient };
