"use strict";

const crypto = require("node:crypto");

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_LEASE_MS = 30_000;

function createControlManager({
  runtimeId = `runtime-${crypto.randomUUID()}`,
  executionEpoch = 1,
  sessionGeneration = 1,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  leaseMs = DEFAULT_LEASE_MS,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const bindings = new Map();
  let controlEpoch = 1;
  let state = "unowned";
  let owner = null;
  let activeRun = null;
  let handoff = null;

  return {
    acquire,
    beginHandoff,
    bindConnection,
    completeHandoff,
    disconnect,
    heartbeat,
    isSafeBoundary,
    releaseRun,
    releaseControl,
    revoke,
    snapshot,
    setSessionGeneration,
    reserveRun,
    tick,
    assertCanWrite,
    connectionStatus,
  };

  function bindConnection({clientId, resumptionSecret = "", connectionId, surface = "web"} = {}) {
    const id = bounded(clientId, "client_id_invalid");
    const connection = bounded(connectionId, "connection_id_invalid");
    const suppliedSecret = String(resumptionSecret || "");
    let binding = bindings.get(id);
    const resumed = Boolean(binding);
    if (!binding) {
      if (suppliedSecret) throw controlError("control_binding_invalid");
      binding = {
        clientId: id,
        secret: randomSecret(randomBytes),
        activeConnectionId: null,
        surface: cleanSurface(surface),
        lastSeenAt: now(),
      };
      bindings.set(id, binding);
    } else if (!safeEqualSecret(binding.secret, suppliedSecret)) {
      throw controlError("control_binding_invalid");
    }
    if (binding.activeConnectionId && binding.activeConnectionId !== connection) {
      throw controlError("control_binding_in_use");
    }
    binding.activeConnectionId = connection;
    binding.surface = cleanSurface(surface);
    binding.lastSeenAt = now();
    return {
      clientId: id,
      connectionId: connection,
      resumptionSecret: binding.secret,
      resumed: resumed && Boolean(owner && owner.clientId === id),
      control: snapshot(),
    };
  }

  function acquire({clientId, resumptionSecret, connectionId, surface = "web"} = {}) {
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    expireIfNeeded();
    if (handoff) throw controlError("control_handoff_pending");
    if (activeRun && (!owner || owner.clientId !== binding.clientId)) {
      throw controlError("operation_in_progress");
    }
    if (owner && owner.clientId !== binding.clientId) throw controlError("control_busy");
    const changed = !owner;
    if (changed) controlEpoch += 1;
    state = "owned";
    owner = {
      clientId: binding.clientId,
      connectionId: binding.activeConnectionId,
      surface: cleanSurface(surface || binding.surface),
      inputEpoch: controlEpoch,
      expiresAt: now() + leaseMs,
    };
    binding.surface = owner.surface;
    binding.lastSeenAt = now();
    return {ok: true, acquired: changed, control: snapshot()};
  }

  function heartbeat({clientId, resumptionSecret, connectionId, expectedControlEpoch} = {}) {
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    expireIfNeeded();
    if (!owner || owner.clientId !== binding.clientId || owner.connectionId !== binding.activeConnectionId) {
      throw controlError("control_required");
    }
    if (expectedControlEpoch !== undefined && expectedControlEpoch !== controlEpoch) {
      throw controlError("stale_control_epoch");
    }
    owner.expiresAt = now() + leaseMs;
    binding.lastSeenAt = now();
    return {ok: true, control: snapshot()};
  }

  function beginHandoff({clientId, resumptionSecret, connectionId, mode = "wait"} = {}) {
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    assertOwner(binding, connectionId);
    if (handoff) throw controlError("control_handoff_pending");
    state = "handoff_pending";
    handoff = {
      id: `handoff-${crypto.randomUUID()}`,
      mode: mode === "interrupt" ? "interrupt" : "wait",
      previousClientId: binding.clientId,
      previousInputEpoch: owner.inputEpoch,
      startedAt: now(),
    };
    binding.activeConnectionId = null;
    owner = null;
    controlEpoch += 1;
    return {ok: true, handoff: {...handoff}, control: snapshot()};
  }

  function completeHandoff({clientId, resumptionSecret, connectionId, safe = false, surface = "web"} = {}) {
    if (!handoff) throw controlError("control_handoff_missing");
    if (!safe) throw controlError("control_not_quiescent");
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    if (activeRun) throw controlError("operation_in_progress");
    owner = {
      clientId: binding.clientId,
      connectionId: binding.activeConnectionId,
      surface: cleanSurface(surface || binding.surface),
      inputEpoch: controlEpoch,
      expiresAt: now() + leaseMs,
    };
    state = "owned";
    handoff = null;
    return {ok: true, control: snapshot()};
  }

  function releaseControl({clientId, resumptionSecret, connectionId} = {}) {
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    assertOwner(binding, connectionId);
    owner = null;
    state = "unowned";
    controlEpoch += 1;
    return {ok: true, control: snapshot()};
  }

  function revoke(reason = "revoked") {
    owner = null;
    state = "unowned";
    controlEpoch += 1;
    handoff = null;
    return {ok: true, reason: cleanReason(reason), control: snapshot()};
  }

  function reserveRun({runId, clientId, resumptionSecret, connectionId, type = "root"} = {}) {
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    assertOwner(binding, connectionId);
    if (activeRun) throw controlError("operation_in_progress");
    activeRun = {
      runId: bounded(runId, "run_id_invalid"),
      type: cleanSurface(type),
      clientId: binding.clientId,
      controlEpoch,
      startedAt: now(),
    };
    return {ok: true, run: {...activeRun}, control: snapshot()};
  }

  function releaseRun(runId) {
    if (!activeRun || activeRun.runId !== String(runId || "")) return false;
    activeRun = null;
    return true;
  }

  function assertCanWrite({clientId, resumptionSecret, connectionId, expectedControlEpoch, inputEpoch} = {}) {
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    expireIfNeeded();
    assertOwner(binding, connectionId);
    if (expectedControlEpoch !== undefined && expectedControlEpoch !== controlEpoch) {
      throw controlError("stale_control_epoch");
    }
    if (inputEpoch !== undefined && inputEpoch !== owner.inputEpoch) throw controlError("stale_input_epoch");
    return true;
  }

  function connectionStatus({clientId, resumptionSecret, connectionId} = {}) {
    const binding = requireBinding(clientId, resumptionSecret, connectionId);
    return {
      bound: true,
      active: binding.activeConnectionId === connectionId,
      owner: Boolean(owner && owner.clientId === binding.clientId),
      control: snapshot(),
    };
  }

  function disconnect(connectionId) {
    const id = String(connectionId || "");
    for (const binding of bindings.values()) {
      if (binding.activeConnectionId !== id) continue;
      binding.activeConnectionId = null;
      binding.lastSeenAt = now();
    }
  }

  function tick() {
    return expireIfNeeded();
  }

  function setSessionGeneration(nextGeneration) {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 1) throw controlError("session_generation_invalid");
    sessionGeneration = nextGeneration;
  }

  function expireIfNeeded() {
    if (!owner || owner.expiresAt > now()) return false;
    owner = null;
    state = "unowned";
    controlEpoch += 1;
    return true;
  }

  function isSafeBoundary() {
    return !activeRun && !handoff && state !== "handoff_pending";
  }

  function snapshot() {
    expireIfNeeded();
    return {
      runtimeId,
      executionEpoch,
      sessionGeneration,
      controlEpoch,
      state,
      admissionOpen: state === "owned" && !handoff,
      controllerClientId: owner?.clientId || null,
      surface: owner?.surface || null,
      inputEpoch: owner?.inputEpoch || null,
      expiresAt: owner?.expiresAt || null,
      activeRun: activeRun ? {...activeRun} : null,
      handoff: handoff ? {...handoff} : null,
      heartbeatMs,
      leaseMs,
    };
  }

  function requireBinding(clientId, secret, connectionId) {
    const id = bounded(clientId, "client_id_invalid");
    const binding = bindings.get(id);
    if (!binding || !safeEqualSecret(binding.secret, String(secret || ""))) {
      throw controlError("control_binding_invalid");
    }
    if (binding.activeConnectionId !== String(connectionId || "")) throw controlError("control_connection_invalid");
    return binding;
  }

  function assertOwner(binding, connectionId) {
    if (!owner || owner.clientId !== binding.clientId || owner.connectionId !== String(connectionId || "")) {
      throw controlError("control_required");
    }
  }
}

function randomSecret(randomBytes) {
  return randomBytes(32).toString("base64url");
}

function safeEqualSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return Boolean(a.length && a.length === b.length && crypto.timingSafeEqual(a, b));
}

function bounded(value, code) {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) throw controlError(code);
  return text;
}

function cleanSurface(value) {
  return String(value || "web").trim().slice(0, 32) || "web";
}

function cleanReason(value) {
  return String(value || "revoked").trim().slice(0, 128) || "revoked";
}

function controlError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  createControlManager,
};
