"use strict";

function createChromeProfileSnapshotService({
  config = {},
  profile,
  snapshot,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  const enabled = Boolean(config.chromeEnabled || config.runnerCapabilities?.chrome);
  const intervalMs = Number(config.archiveSyncIntervalMs || 300000);
  let timer = null;
  let inFlight = null;
  let lastSnapshotAt = null;
  let lastError = null;

  return {
    enabled: () => enabled,
    start,
    snapshot: () => runSnapshot(false),
    finalize: () => runFinalSnapshot(),
    stop,
    status,
  };

  function start() {
    if (!enabled || timer) return status();
    timer = setIntervalImpl(() => {
      runSnapshot(false).catch((error) => {
        lastError = error;
        logger.error("Chrome profile snapshot failed", error);
      });
    }, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return status();
  }

  async function runSnapshot(final) {
    if (!enabled) return {enabled: false, skipped: true};
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(async () => {
      if (final && profile && typeof profile.sanitize === "function") await profile.sanitize();
      const result = await snapshot({final});
      lastSnapshotAt = Date.now();
      lastError = null;
      return {enabled: true, final, result};
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function runFinalSnapshot() {
    if (!enabled) return {enabled: false, skipped: true};
    if (inFlight) await inFlight;
    return runSnapshot(true);
  }

  async function stop() {
    if (timer) clearIntervalImpl(timer);
    timer = null;
    return status();
  }

  function status() {
    return {
      enabled,
      running: Boolean(timer),
      snapshotInFlight: Boolean(inFlight),
      lastSnapshotAt,
      error: lastError ? String(lastError.message || lastError) : null,
    };
  }
}

module.exports = {
  createChromeProfileSnapshotService,
};
