"use strict";

function createWorkspaceSyncCoordinator({syncUp: performSyncUp, syncDown: performSyncDown, syncWriterRole = "writer", logger = console}) {
  let active = null;
  let pendingUp = null;
  let pendingDown = null;
  let sequence = 0;
  let uploadSkipLogged = false;

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
      const result = request.kind === "up" ?
        await performSyncUp({includeArchives: request.includeArchives}) :
        await performSyncDown();
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
    flush,
    syncDown: () => enqueue("down"),
    syncUp,
  };
}

module.exports = {createWorkspaceSyncCoordinator};
