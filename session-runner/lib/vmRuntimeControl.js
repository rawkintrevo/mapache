"use strict";

const {randomUUID} = require("node:crypto");

function createVmRuntimeControlClient({config, fetchImpl = fetch, bootId = randomUUID()}) {
  const url = new URL(config.vmControlUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !config.vmControlToken || config.vmControlToken.length < 32) throw new Error("vm_control_configuration_invalid");
  return {
    bootId,
    async call(action, payload) {
      const response = await fetchImpl(url.href, {
        method: "POST",
        redirect: "error",
        headers: {"content-type": "application/json", authorization: `Bearer ${config.vmControlToken}`},
        body: JSON.stringify({action, payload, bootId, workspaceId: config.workspaceId,
          sessionId: config.sessionId, generation: Number(config.agentRuntimeGeneration)}),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || "vm_control_unavailable");
        error.code = result.error || "vm_control_unavailable";
        throw error;
      }
      return result;
    },
  };
}

function createVmWorkspaceAuthority({client, config, onLost, now = Date.now,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, logger = console}) {
  let admitted = false;
  let expiresAt = 0;
  let timer;
  let renewing = false;
  const status = () => ({enabled: true, admitted: admitted && now() < expiresAt,
    bootInstanceId: client.bootId, generation: Number(config.agentRuntimeGeneration),
    workspaceId: config.workspaceId, sessionId: config.sessionId});
  async function lose(error) {
    const wasAdmitted = admitted;
    admitted = false;
    clearIntervalFn(timer);
    timer = null;
    if (wasAdmitted) await onLost?.(error);
  }
  async function check(action) {
    if (!admitted) throw new Error("workspace_writer_authority_lost");
    try {
      const result = await client.call(action);
      expiresAt = result.leaseExpiresAt;
      return true;
    } catch (error) {
      await lose(error);
      throw error;
    }
  }
  const renew = async () => {
    if (renewing || !admitted) return false;
    renewing = true;
    try { return await check("lease.renew"); } finally { renewing = false; }
  };
  return {
    enabled: () => true,
    status,
    isCurrentWriter: () => status().admitted,
    assertCurrentWriter: () => check("lease.check"),
    renew,
    async acquire() {
      const result = await client.call("lease.acquire");
      admitted = true;
      expiresAt = result.leaseExpiresAt;
      clearIntervalFn(timer);
      timer = setIntervalFn(() => void renew().catch((error) => logger.warn("VM authority renewal failed", {code: error.code || "vm_control_unavailable"})), 5000);
      timer?.unref?.();
      return status();
    },
    async release() {
      const wasAdmitted = admitted;
      admitted = false;
      clearIntervalFn(timer);
      timer = null;
      if (!wasAdmitted) return false;
      await client.call("lease.release");
      return true;
    },
    async revokeForQa() {
      await client.call("lease.release");
      await lose(new Error("qa_writer_revoked"));
      return {ok: true};
    },
  };
}

module.exports = {createVmRuntimeControlClient, createVmWorkspaceAuthority};
