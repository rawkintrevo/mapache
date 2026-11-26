"use strict";

// The remote host runs one retained guest per workspace. Its lifecycle-issued
// boot identity is revalidated by the broker; no cloud credential enters it.
function createRemoteWorkspaceAuthority({config, remoteCredentials, onLost, logger = console,
  now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout}) {
  let admitted = false;
  let expiresAt = 0;
  let interval;
  let expiry;
  let epoch = 0;
  let inFlight;
  const error = () => Object.assign(new Error("workspace_runtime_authority_denied"), {code: "workspace_runtime_authority_denied"});
  const current = () => admitted && now() < expiresAt;
  const status = () => ({enabled: true, admitted: current(), bootInstanceId: config.agentRuntimeBootInstanceId,
    generation: Number(config.agentRuntimeGeneration), sessionId: config.sessionId, workspaceId: config.workspaceId});
  function release() {
    const previous = admitted;
    epoch += 1;
    admitted = false;
    expiresAt = 0;
    clearIntervalFn(interval);
    clearTimeoutFn(expiry);
    return previous;
  }
  async function lose() {
    const previous = release();
    if (previous) {
      try { await onLost?.(error()); } catch { logger.error("remote runtime stop failed after authority loss"); }
    }
  }
  async function refresh() {
    if (inFlight) return inFlight;
    const attempt = epoch;
    inFlight = (async () => {
      try {
        if (!config.agentRuntimeBootInstanceId || !remoteCredentials?.enabled()) throw error();
        const result = await remoteCredentials.materialize({force: true});
        const until = Math.min(Date.parse(result?.expiresAt), now() + 15000);
        if (attempt !== epoch || !Number.isFinite(until) || until <= now() ||
            String(result.generation) !== String(config.agentRuntimeGeneration)) throw error();
        expiresAt = until;
        admitted = true;
        clearTimeoutFn(expiry);
        expiry = setTimeoutFn(() => { void lose(); }, Math.max(1, until - now()));
        expiry?.unref?.();
        return status();
      } catch {
        if (attempt === epoch) await lose();
        throw error();
      }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  async function acquire() {
    await refresh();
    clearIntervalFn(interval);
    interval = setIntervalFn(() => { void refresh().catch(() => {}); }, 5000);
    interval?.unref?.();
    return status();
  }
  return {acquire, renew: refresh, release: async () => release(), enabled: () => true, status,
    isCurrentWriter: current,
    assertCurrentWriter: async () => { if (!current()) { await lose(); throw error(); } return true; },
    revokeForQa: async () => { await lose(); }};
}

module.exports = {createRemoteWorkspaceAuthority};
