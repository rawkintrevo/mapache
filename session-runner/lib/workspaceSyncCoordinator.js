"use strict";

function createWorkspaceSyncCoordinator({
  syncUp: performSyncUp,
  syncDown: performSyncDown,
  syncChromeProfileUp: performChromeProfileUp,
  syncWriterRole = "writer",
  mutationBarrier,
  executionAuthority,
  webFirstEnabled = false,
  logger = console,
}) {
  let active = null;
  let pendingUp = null;
  let pendingDown = null;
  let sequence = 0;
  let uploadSkipLogged = false;
  let fenced = false;

  function enqueue(kind, options = {}) {
    const pending = kind === "up" ? pendingUp : pendingDown;
    if (pending) {
      if (kind === "up") pending.includeArchives = pending.includeArchives || Boolean(options.includeArchives);
      return pending.promise;
    }

    let resolveRequest;
    let rejectRequest;
    const request = {
      id: ++sequence,
      kind,
      includeArchives: Boolean(options.includeArchives),
      promise: new Promise((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
      }),
      resolve: resolveRequest,
      reject: rejectRequest,
    };
    if (kind === "up") pendingUp = request;
    else pendingDown = request;
    void pump();
    return request.promise;
  }

  async function pump() {
    if (active) return;
    const request = pendingDown || pendingUp;
    if (!request) return;
    if (request.kind === "up") pendingUp = null;
    else pendingDown = null;
    active = request;
    try {
      assertRunnerMutation(request.kind === "up" ? "workspace_sync_up" : "workspace_sync_down");
      const result = request.kind === "up" ?
        await withBarrier("workspace_sync_up", () => performSyncUp({includeArchives: request.includeArchives})) :
        await withBarrier("workspace_sync_down", () => performSyncDown());
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      active = null;
      void pump();
    }
  }

  async function flush() {
    while (active || pendingUp || pendingDown) {
      const current = active?.promise || pendingDown?.promise || pendingUp?.promise;
      if (current) await current.catch(() => {});
      else await new Promise((resolve) => setImmediate(resolve));
    }
  }

  function syncUp(options = {}) {
    assertRunnerMutation("workspace_sync_up");
    if (syncWriterRole !== "writer") {
      if (!uploadSkipLogged) {
        logger.log(`workspace sync up skipped: sync-writer role is ${syncWriterRole}`);
        uploadSkipLogged = true;
      }
      return Promise.resolve({
        conflicts: [],
        role: syncWriterRole,
        skipped: "sync_writer_lease",
      });
    }
    return enqueue("up", options);
  }

  return {
    fence(reason = "execution_authority_lost") {
      fenced = true;
      const error = syncError(String(reason || "execution_authority_lost"));
      for (const request of [pendingUp, pendingDown]) {
        if (!request) continue;
        request.reject(error);
      }
      pendingUp = null;
      pendingDown = null;
    },
    flush,
    syncChromeProfileUp: () => {
      assertRunnerMutation("chrome_profile_sync");
      if (syncWriterRole !== "writer") {
        if (!uploadSkipLogged) {
          logger.log(`workspace sync up skipped: sync-writer role is ${syncWriterRole}`);
          uploadSkipLogged = true;
        }
        return Promise.resolve({skipped: "sync_writer_lease", role: syncWriterRole});
      }
      if (typeof performChromeProfileUp !== "function") {
        return Promise.resolve({skipped: true, reason: "chrome_profile_archive_unavailable"});
      }
      return withBarrier("chrome_profile_sync", () => performChromeProfileUp());
    },
    syncDown: () => {
      assertRunnerMutation("workspace_sync_down");
      return enqueue("down");
    },
    syncUp,
  };

  function assertRunnerMutation(label) {
    if (!webFirstEnabled) return true;
    if (fenced) throw syncError("execution_authority_lost");
    executionAuthority?.assertAuthority?.();
    mutationBarrier?.assertOpen?.(label);
    return true;
  }

  async function withBarrier(label, operation) {
    if (!webFirstEnabled || !mutationBarrier) return operation();
    const token = mutationBarrier.enter(label);
    try {
      return await operation();
    } finally {
      mutationBarrier.leave(token);
    }
  }
}

function syncError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {createWorkspaceSyncCoordinator};
