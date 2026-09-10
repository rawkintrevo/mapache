"use strict";

const crypto = require("node:crypto");
const {WebSocketServer, WebSocket} = require("ws");
const {createControlManager} = require("./controlManager");
const {
  createFileOperationStore,
  createOperationLedger,
} = require("./operationLedger");
const {
  MAX_ENVELOPE_BYTES,
  WEB_FIRST_PROTOCOL_VERSION,
  normalizeCommandEnvelope,
  protocolError,
} = require("./webFirstProtocol");

const MAX_EVENT_REPLAY = 256;
const MAX_BUFFERED_BYTES = 512 * 1024;

function createWebFirstAgentGateway({
  config = {},
  adapter,
  terminalSession,
  controlManager,
  ledger,
  operationStore,
  mutationBarrier,
  executionAuthority,
  runtimeId: configuredRuntimeId,
  WebSocketServerClass = WebSocketServer,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const supported = Boolean(config.webFirstEnabled);
  const runtimeId = configuredRuntimeId || `runtime-${crypto.randomUUID()}`;
  let executionEpoch = Math.max(1, now());
  const manager = controlManager || createControlManager({
    runtimeId,
    executionEpoch,
    sessionGeneration: 1,
    heartbeatMs: config.webFirstHeartbeatMs,
    leaseMs: config.webFirstLeaseMs,
    now,
  });
  const operationLedger = ledger || createOperationLedger({
    store: operationStore || (config.webFirstOperationLedgerPath ? createFileOperationStore({filePath: config.webFirstOperationLedgerPath}) : undefined),
    now: () => new Date(now()).toISOString(),
    runtimeId,
    executionEpoch,
  });
  const server = new WebSocketServerClass({noServer: true, maxPayload: MAX_ENVELOPE_BYTES});
  const sockets = new Map();
  const legacyConnections = new Map();
  const eventLog = [];
  let sequence = 0;
  let sessionGeneration = 1;
  let adapterIdentity = null;
  let adapterAvailable = false;
  let adapterCompatibility = {status: "not_connected", reason: "adapter_not_connected"};
  let initialized = false;
  let heartbeatTimer = null;
  let checkpointService = null;
  let fenced = false;

  const unsubscribeAdapter = [];
  if (adapter?.on) {
    unsubscribeAdapter.push(adapter.on("event", (event) => void handleAdapterEvent(event)));
    unsubscribeAdapter.push(adapter.on("handshake", (identity) => {
      const nextGeneration = Number(identity?.sessionGeneration || sessionGeneration);
      if (nextGeneration !== sessionGeneration) {
        sessionGeneration = nextGeneration;
        manager.setSessionGeneration?.(sessionGeneration);
        manager.revoke("adapter_generation_changed");
      }
      adapterIdentity = identity ? {...identity} : null;
      adapterAvailable = true;
      adapterCompatibility = {status: "supported", reason: "handshake_valid"};
      publish("adapter_handshake", safeAdapterIdentity(identity));
    }));
    unsubscribeAdapter.push(adapter.on("disconnect", () => {
      adapterAvailable = false;
      adapterIdentity = null;
      adapterCompatibility = {status: "unavailable", reason: "web_first_adapter_disconnected"};
      const activeRoot = operationLedger.snapshot().activeRoot;
      if (activeRoot) {
        void operationLedger.setOutcome(activeRoot.commandId, "unknown", "outcome_unknown");
      }
      publish("adapter_disconnect", {code: "web_first_adapter_disconnected"});
    }));
  }

  server.on("connection", (socket, request) => {
    if (!supported) {
      socket.close(1008, "unsupported");
      return;
    }
    const connectionId = `agent-${crypto.randomUUID()}`;
    const state = {socket, request, connectionId, clientId: "", resumptionSecret: "", bound: false};
    sockets.set(connectionId, state);
    socket.on("message", (raw) => void handleSocketMessage(state, raw));
    socket.once("close", () => {
      sockets.delete(connectionId);
      manager.disconnect(connectionId);
    });
    socket.on("error", () => {});
    send(state, {type: "status", status: "awaiting_hello", protocolVersion: WEB_FIRST_PROTOCOL_VERSION});
  });

  return {
    server,
    supported,
    capabilities,
    initialize,
    close,
    snapshot,
    openLegacyConnection,
    closeLegacyConnection,
    submitLegacyPrompt,
    controlManager: manager,
    operationLedger,
    setExecutionEpoch(nextEpoch) {
      if (initialized || !Number.isSafeInteger(nextEpoch) || nextEpoch < 1) return false;
      executionEpoch = nextEpoch;
      manager.setExecutionEpoch?.(nextEpoch);
      operationLedger.setExecutionEpoch?.(nextEpoch);
      return true;
    },
    setCheckpointService(service) {
      checkpointService = service || null;
    },
    fence,
  };

  async function initialize() {
    if (initialized) return;
    await operationLedger.initialize();
    initialized = true;
    heartbeatTimer = setInterval(() => {
      manager.tick();
      publish("control_state", manager.snapshot());
    }, Math.max(1000, Number(config.webFirstHeartbeatMs || 10_000)));
    heartbeatTimer.unref?.();
  }

  function capabilities() {
    return {
      ok: true,
      enabled: supported,
      integrationMode: config.integrationMode || (supported ? "web-first" : "legacy"),
      protocolVersion: WEB_FIRST_PROTOCOL_VERSION,
      runtimeId,
      executionEpoch,
      sessionGeneration,
      transport: "agent-websocket",
      adapter: safeAdapterIdentity(adapterIdentity),
      adapterAvailable,
      compatibility: {...adapterCompatibility},
      ...adapterCapabilities(adapterIdentity, adapterAvailable),
      control: manager.snapshot(),
      executionAuthority: executionAuthority?.snapshot?.() || null,
      checkpoint: checkpointService?.status?.() || null,
    };
  }

  async function close() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    for (const unsubscribe of unsubscribeAdapter) unsubscribe?.();
    for (const state of sockets.values()) state.socket.close(1001, "runner_shutdown");
    sockets.clear();
    for (const state of legacyConnections.values()) manager.disconnect(state.connectionId);
    legacyConnections.clear();
    server.close();
  }

  async function handleSocketMessage(state, raw) {
    if (Buffer.isBuffer(raw) && raw.length > MAX_ENVELOPE_BYTES) {
      sendError(state, "message_too_large");
      state.socket.close(1009, "message_too_large");
      return;
    }
    let message;
    try {
      message = parseMessage(raw);
    } catch (error) {
      sendError(state, error.code || "invalid_json");
      return;
    }
    try {
      if (!state.bound) {
        if (message.type !== "hello") throw protocolError("hello_required");
        await handleHello(state, message);
        return;
      }
      if (message.type === "hello") {
        await handleHello(state, message);
        return;
      }
      const envelope = normalizeCommandEnvelope(message, {
        runtimeId,
        executionEpoch,
        sessionGeneration,
      });
      const result = await dispatch(state, envelope);
      send(state, {type: "result", commandId: envelope.commandId, ...result});
    } catch (error) {
      sendError(state, error.code || "agent_command_failed", error.details, message.commandId);
    }
  }

  async function handleHello(state, message) {
    const clientId = bounded(message.clientId, "client_id_invalid");
    const binding = manager.bindConnection({
      clientId,
      connectionId: state.connectionId,
      resumptionSecret: message.resumptionSecret,
      surface: message.surface || "web",
    });
    state.clientId = clientId;
    state.resumptionSecret = binding.resumptionSecret;
    state.bound = true;
    const replay = await snapshotWithReplay(Number.isSafeInteger(message.since) ? message.since : null);
    send(state, {
      type: "hello",
      protocolVersion: WEB_FIRST_PROTOCOL_VERSION,
      runtimeId,
      executionEpoch,
      sessionGeneration,
      connectionId: state.connectionId,
      clientId,
      resumptionSecret: binding.resumptionSecret,
      resumed: binding.resumed,
      ...replay,
    });
  }

  async function dispatch(state, envelope) {
    assertControlEpoch(envelope);
    if (envelope.type === "heartbeat") {
      return manager.heartbeat({
        clientId: state.clientId,
        resumptionSecret: state.resumptionSecret,
        connectionId: state.connectionId,
        expectedControlEpoch: envelope.controlEpoch,
      });
    }
    if (envelope.type === "control_acquire" || envelope.type === "control_resume") {
      return manager.acquire({
        clientId: state.clientId,
        resumptionSecret: state.resumptionSecret,
        connectionId: state.connectionId,
        surface: envelope.payload.surface || "web",
      });
    }
    if (envelope.type === "control_revoke") {
      return manager.releaseControl({
        clientId: state.clientId,
        resumptionSecret: state.resumptionSecret,
        connectionId: state.connectionId,
      });
    }
    if (envelope.type === "control_handoff") return dispatchHandoff(state, envelope);
    if (envelope.type === "control_complete") return dispatchHandoffComplete(state, envelope);

    manager.assertCanWrite({
      clientId: state.clientId,
      resumptionSecret: state.resumptionSecret,
      connectionId: state.connectionId,
      expectedControlEpoch: envelope.controlEpoch,
    });

    if (envelope.type === "prompt") assertMutation("agent_prompt");

    if (envelope.type === "prompt") return dispatchPrompt(state, envelope);
    return dispatchControl(state, envelope);
  }

  async function dispatchPrompt(state, envelope) {
    assertMutation("agent_prompt");
    mutationBarrier?.assertQuiescent?.("agent_prompt");
    const runId = envelope.runId || `run-${envelope.commandId}`;
    const admission = await operationLedger.admit(envelope, {runId});
    if (admission.duplicate) return {ok: true, duplicate: true, operation: admission.record};
    manager.assertCanWrite({
      clientId: state.clientId,
      resumptionSecret: state.resumptionSecret,
      connectionId: state.connectionId,
      expectedControlEpoch: envelope.controlEpoch,
    });
    manager.reserveRun({
      runId,
      clientId: state.clientId,
      resumptionSecret: state.resumptionSecret,
      connectionId: state.connectionId,
      type: "root",
    });
    try {
      await ensureAdapter();
    } catch (error) {
      manager.releaseRun(runId);
      await operationLedger.releaseRoot(runId, {commandId: envelope.commandId});
      throw error;
    }
    manager.assertCanWrite({
      clientId: state.clientId,
      resumptionSecret: state.resumptionSecret,
      connectionId: state.connectionId,
      expectedControlEpoch: envelope.controlEpoch,
    });
    await operationLedger.consumeDispatchPermit(envelope.commandId, {
      runtimeId,
      executionEpoch,
      sessionGeneration,
      controlEpoch: envelope.controlEpoch,
    });
    try {
      const result = await adapter.request("prompt", {message: envelope.payload.message, runId}, {
        requestId: envelope.commandId,
        expectedSessionGeneration: sessionGeneration,
      });
      await operationLedger.event("operation_dispatch", {
        commandId: envelope.commandId,
        runId,
        accepted: result?.accepted === true,
      });
      publish("operation_dispatch", {commandId: envelope.commandId, runId, accepted: result?.accepted === true});
      return {
        ok: true,
        accepted: result?.accepted === true,
        operation: operationLedger.get(envelope.commandId),
        control: manager.snapshot(),
      };
    } catch (error) {
      await operationLedger.setOutcome(envelope.commandId, "unknown", "outcome_unknown");
      throw error;
    }
  }

  async function dispatchControl(state, envelope) {
    // A failed checkpoint blocks new roots and ordinary controls, but stop must
    // remain available so an operator can quiesce the live adapter before
    // recovering or retrying durability.
    assertMutation(`agent_${envelope.type}`, {allowBlocked: envelope.type === "stop"});
    const admission = await operationLedger.admit(envelope);
    if (admission.duplicate) return {ok: true, duplicate: true, operation: admission.record};
    await operationLedger.consumeDispatchPermit(envelope.commandId, {
      runtimeId,
      executionEpoch,
      sessionGeneration,
      controlEpoch: envelope.controlEpoch,
    });
    try {
      const operation = envelope.type === "stop" ? "cancel" : envelope.type === "pause" ? "pause" : "dialog_answer";
      const payload = envelope.type === "dialog_answer" ? {
        runId: envelope.payload.runId,
        dialogRequestId: envelope.payload.dialogRequestId,
        response: envelope.payload.response,
      } : {runId: envelope.payload.runId};
      const result = await ensureAdapter().then(() => adapter.request(operation, payload, {
        requestId: envelope.commandId,
        expectedSessionGeneration: sessionGeneration,
      }));
      if (envelope.type === "stop" && result?.accepted) {
        await operationLedger.setOutcome(envelope.commandId, "canceled", "interrupted");
      }
      if (envelope.type !== "stop" && result?.accepted !== true) {
        await operationLedger.setOutcome(envelope.commandId, "unknown", "outcome_unknown");
      }
      publish("control_dispatch", {commandId: envelope.commandId, type: envelope.type, accepted: result?.accepted === true});
      return {ok: true, accepted: result?.accepted === true, operation: operationLedger.get(envelope.commandId)};
    } catch (error) {
      await operationLedger.setOutcome(envelope.commandId, "failure", "execution_finished");
      throw error;
    }
  }

  async function dispatchHandoff(state, envelope) {
    assertMutation("agent_handoff");
    const admission = await operationLedger.admit(envelope);
    if (admission.duplicate) return {ok: true, duplicate: true, operation: admission.record};
    await operationLedger.consumeDispatchPermit(envelope.commandId, {runtimeId, executionEpoch, sessionGeneration, controlEpoch: envelope.controlEpoch});
    const handoff = manager.beginHandoff({
      clientId: state.clientId,
      resumptionSecret: state.resumptionSecret,
      connectionId: state.connectionId,
      mode: envelope.payload.mode,
    });
    const activeRun = handoff.control.activeRun;
    if (handoff.handoff.mode === "interrupt" && activeRun) {
      try {
        await ensureAdapter();
        await adapter.request("cancel", {runId: activeRun.runId}, {
          requestId: envelope.commandId,
          expectedSessionGeneration: sessionGeneration,
        });
        await operationLedger.setOutcome(envelope.commandId, "canceled", "interrupted");
      } catch (error) {
        await operationLedger.setOutcome(envelope.commandId, "unknown", "outcome_unknown");
        throw error;
      }
    }
    publish("control_handoff", handoff);
    return {ok: true, pending: true, handoff, operation: operationLedger.get(envelope.commandId)};
  }

  async function dispatchHandoffComplete(state, envelope) {
    assertMutation("agent_handoff_complete");
    const admission = await operationLedger.admit(envelope);
    if (admission.duplicate) return {ok: true, duplicate: true, operation: admission.record};
    await operationLedger.consumeDispatchPermit(envelope.commandId, {runtimeId, executionEpoch, sessionGeneration, controlEpoch: envelope.controlEpoch});
    try {
      const result = manager.completeHandoff({
        clientId: state.clientId,
        resumptionSecret: state.resumptionSecret,
        connectionId: state.connectionId,
        safe: envelope.payload.safe === true,
        surface: envelope.payload.surface || "web",
      });
      await operationLedger.setOutcome(envelope.commandId, "success");
      publish("control_handoff_complete", result);
      return {ok: true, ...result, operation: operationLedger.get(envelope.commandId)};
    } catch (error) {
      await operationLedger.setOutcome(envelope.commandId, "failure");
      throw error;
    }
  }

  async function ensureAdapter() {
    if (!adapter || typeof adapter.connect !== "function") throw agentError("web_first_adapter_unavailable");
    if (!adapterAvailable) {
      await terminalSession?.ensureForAgent?.();
      try {
        adapterIdentity = await adapter.connect({timeoutMs: config.webFirstAdapterTimeoutMs});
      } catch (error) {
        adapterCompatibility = {
          status: "incompatible",
          reason: String(error?.code || "web_first_adapter_unavailable").slice(0, 128),
          ...(error?.details ? {details: boundedObject(error.details)} : {}),
        };
        throw error;
      }
      sessionGeneration = Number(adapterIdentity?.sessionGeneration || sessionGeneration);
      manager.setSessionGeneration?.(sessionGeneration);
      adapterAvailable = true;
    }
    return adapterIdentity;
  }

  function assertControlEpoch(envelope) {
    const current = manager.snapshot();
    if (envelope.controlEpoch !== current.controlEpoch) throw agentError("stale_control_epoch");
  }

  async function handleAdapterEvent(event) {
    const safe = safeAdapterEvent(event);
    if (safe.sessionGeneration && safe.sessionGeneration !== sessionGeneration) {
      await operationLedger.event("stale_runtime_event", safe);
      publish("stale_runtime_event", safe);
      return;
    }
    if (safe.rootRequestId) {
      try {
        await operationLedger.recordEvidence(safe.rootRequestId, {
          id: `${safe.rootRequestId}:${safe.event}:${safe.sequence || now()}`,
          type: safe.event,
          sessionGeneration: safe.sessionGeneration,
          piSession: safe.piSession,
          summary: safe.summary,
        });
      } catch (error) {
        if (error.code !== "operation_not_found") logger.warn?.("web-first event correlation failed", error);
      }
    }
    if (safe.event === "agent_settled" && manager.snapshot().state === "handoff_pending") {
      const runId = manager.snapshot().activeRun?.runId;
      if (runId) manager.releaseRun(runId);
    }
    if (safe.event === "agent_settled" && safe.rootRequestId && checkpointService) {
      try {
        const checkpoint = await checkpointService.create({reason: "agent_settled", allowActiveRun: true});
        const runId = manager.snapshot().activeRun?.runId;
        if (runId) manager.releaseRun(runId);
        await operationLedger.releaseRoot(runId, {commandId: safe.rootRequestId});
        publish("checkpoint_committed", {
          checkpointId: checkpoint.checkpointId,
          commandId: safe.rootRequestId,
          durability: "checkpoint_committed",
        });
      } catch (error) {
        publish("checkpoint_failed", {
          commandId: safe.rootRequestId,
          code: error.code || "checkpoint_failed",
          recovery: "inspection_and_stop_available",
        });
      }
    }
    publish("adapter_event", safe);
  }

  function assertMutation(label, {allowBlocked = false} = {}) {
    if (fenced) throw agentError("execution_authority_lost");
    executionAuthority?.assertAuthority?.();
    if (!allowBlocked) mutationBarrier?.assertOpen?.(label);
  }

  function fence(reason = "execution_authority_lost") {
    if (fenced) return;
    fenced = true;
    manager.revoke(reason);
    const activeRoot = operationLedger.snapshot().activeRoot;
    if (activeRoot) {
      void operationLedger.setOutcome(activeRoot.commandId, "unknown", "interrupted");
    }
    adapter?.disconnect?.();
    publish("execution_fenced", {reason: String(reason).slice(0, 128)});
  }

  function publish(type, data) {
    const item = {sequence: ++sequence, type: String(type).slice(0, 64), data: boundedObject(data)};
    eventLog.push(item);
    while (eventLog.length > MAX_EVENT_REPLAY) eventLog.shift();
    for (const state of sockets.values()) send(state, {type: "event", ...item});
    return item;
  }

  async function snapshotWithReplay(since) {
    const boundary = sequence;
    const current = await snapshot();
    const response = {sequence: boundary, snapshot: current};
    if (since === null || since === undefined) return response;
    const oldest = eventLog[0]?.sequence || boundary + 1;
    response.replay = since < oldest - 1 ? {gap: true, events: []} : {
      gap: false,
      events: eventLog.filter((item) => item.sequence > since && item.sequence <= boundary).map((item) => ({...item})),
    };
    return response;
  }

  async function snapshot() {
    return {
      protocolVersion: WEB_FIRST_PROTOCOL_VERSION,
      integrationMode: config.integrationMode || (supported ? "web-first" : "legacy"),
      runtimeId,
      executionEpoch,
      sessionGeneration,
      activeResponse: null,
      adapter: safeAdapterIdentity(adapterIdentity),
      control: manager.snapshot(),
      operations: operationLedger.snapshot().operations,
      events: eventLog.slice(-64).map((item) => ({...item})),
      executionAuthority: executionAuthority?.snapshot?.() || null,
      checkpoint: checkpointService?.status?.() || null,
      compatibility: {...adapterCompatibility},
    };
  }

  function openLegacyConnection() {
    const connectionId = `chat-${crypto.randomUUID()}`;
    const clientId = `chat-${connectionId}`;
    legacyConnections.set(connectionId, {connectionId, clientId, secret: ""});
    return {connectionId};
  }

  function closeLegacyConnection(connectionId) {
    const state = legacyConnections.get(connectionId);
    if (!state) return;
    legacyConnections.delete(connectionId);
    manager.disconnect(connectionId);
  }

  async function submitLegacyPrompt({connectionId, clientId, text} = {}) {
    const state = legacyConnections.get(String(connectionId || ""));
    if (!state) throw agentError("control_connection_invalid");
    if (String(clientId || "").trim() === "") throw agentError("client_id_invalid");
    const binding = manager.bindConnection({
      clientId: state.clientId,
      connectionId: state.connectionId,
      resumptionSecret: state.secret,
      surface: "chat",
    });
    state.secret = binding.resumptionSecret;
    manager.acquire({
      clientId: state.clientId,
      resumptionSecret: state.secret,
      connectionId: state.connectionId,
      surface: "chat",
    });
    const control = manager.snapshot();
    const envelope = normalizeCommandEnvelope({
      protocolVersion: WEB_FIRST_PROTOCOL_VERSION,
      runtimeId,
      executionEpoch,
      sessionGeneration,
      controlEpoch: control.controlEpoch,
      commandId: String(clientId).trim(),
      type: "prompt",
      payload: {message: text},
    }, {runtimeId, executionEpoch, sessionGeneration});
    return dispatchPrompt({
      clientId: state.clientId,
      resumptionSecret: state.secret,
      connectionId: state.connectionId,
    }, envelope);
  }

  function sendError(state, code, details, commandId) {
    send(state, {type: "error", code: safeCode(code), ...(commandId ? {commandId: String(commandId).slice(0, 128)} : {}), ...(details ? {details: boundedObject(details)} : {})});
  }

  function send(state, message) {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1013, "backpressure");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }
}

function parseMessage(raw) {
  let message;
  try {
    message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch {
    throw protocolError("invalid_json");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) throw protocolError("invalid_message");
  return message;
}

function safeAdapterIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  return {
    runtime: String(identity.runtime || "").slice(0, 64),
    protocol: String(identity.protocol || "").slice(0, 64),
    piSession: String(identity.piSession || "").slice(0, 256),
    sessionGeneration: Number.isSafeInteger(identity.sessionGeneration) ? identity.sessionGeneration : null,
    adapter: String(identity.adapter || "").slice(0, 128),
    package: identity.package ? {
      name: String(identity.package.name || "").slice(0, 128),
      version: String(identity.package.version || "").slice(0, 64),
    } : null,
    capabilities: adapterCapabilities(identity, true),
  };
}

function adapterCapabilities(identity, available) {
  const capabilities = identity?.capabilities && typeof identity.capabilities === "object" ? identity.capabilities : {};
  const hasCapabilityBlock = identity?.capabilities && typeof identity.capabilities === "object";
  return {
    ordinaryPrompt: Boolean(available && (hasCapabilityBlock ? capabilities.ordinaryPrompt : true)),
    extensionCommands: Boolean(available && capabilities.extensionCommands),
    structuredDialogs: Boolean(available && capabilities.structuredDialogs),
    reload: Boolean(available && capabilities.reload),
    sessionReplacement: Boolean(available && capabilities.sessionReplacement),
  };
}

function safeAdapterEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  return {
    event: String(source.event || "event").slice(0, 64),
    rootRequestId: source.rootRequestId ? String(source.rootRequestId).slice(0, 128) : null,
    sessionGeneration: Number.isSafeInteger(source.sessionGeneration) ? source.sessionGeneration : null,
    piSession: String(source.piSession || "").slice(0, 256),
    summary: boundedObject(source.summary),
  };
}

function bounded(value, code) {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) throw agentError(code);
  return text;
}

function boundedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [
    String(key).slice(0, 64),
    typeof item === "string" ? item.slice(0, 4000) : typeof item === "number" || typeof item === "boolean" ? item : null,
  ]));
}

function safeCode(value) {
  const code = String(value || "agent_command_failed").replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  return code.slice(0, 64) || "agent_command_failed";
}

function agentError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  MAX_BUFFERED_BYTES,
  MAX_EVENT_REPLAY,
  createWebFirstAgentGateway,
};
