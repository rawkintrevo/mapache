"use strict";

function createWorkspaceSyncCoordinator({syncUp, syncDown}) {
  let active = null;
  let pendingUp = null;
  let pendingDown = null;
  let sequence = 0;

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
        await syncUp({includeArchives: request.includeArchives}) :
        await syncDown();
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

  return {
    flush,
    syncDown: () => enqueue("down"),
    syncUp: (options = {}) => enqueue("up", options),
  };
}

module.exports = {createWorkspaceSyncCoordinator};
