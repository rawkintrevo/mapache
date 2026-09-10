"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  createOperationRecord,
  semanticPayloadHash,
} = require("./webFirstProtocol");

const MAX_OPERATIONS = 512;
const MAX_EVENTS = 512;

function createOperationLedger({
  store = createMemoryOperationStore(),
  now = () => new Date().toISOString(),
  runtimeId = "",
  executionEpoch = null,
  maxOperations = MAX_OPERATIONS,
  maxEvents = MAX_EVENTS,
} = {}) {
  const operations = new Map();
  const events = [];
  let activeRoot = null;
  let initialized = false;
  let queue = Promise.resolve();

  return {
    initialize,
    admit,
    consumeDispatchPermit,
    get,
    list,
    recordEvidence,
    setDurability,
    setOutcome,
    setExecutionEpoch,
    releaseRoot,
    event,
    events: () => events.map((item) => ({...item})),
    snapshot,
  };

  async function initialize() {
    if (initialized) return;
    const saved = await store.load();
    for (const record of Array.isArray(saved?.operations) ? saved.operations : []) {
      if (record && record.commandId) operations.set(String(record.commandId), sanitizeRecord(record));
    }
    activeRoot = saved?.activeRoot ? {...saved.activeRoot} : null;
    if (activeRoot && (runtimeId && activeRoot.runtimeId !== runtimeId || executionEpoch !== null && activeRoot.executionEpoch !== executionEpoch)) {
      const interrupted = operations.get(activeRoot.commandId);
      if (interrupted) {
        interrupted.processing = "outcome_unknown";
        interrupted.outcome = "unknown";
        interrupted.updatedAt = now();
      }
      activeRoot = null;
    }
    for (const item of Array.isArray(saved?.events) ? saved.events : []) {
      if (item && Number.isSafeInteger(item.sequence)) events.push({...item});
    }
    initialized = true;
  }

  function setExecutionEpoch(nextEpoch) {
    if (initialized || !Number.isSafeInteger(nextEpoch) || nextEpoch < 1) return false;
    executionEpoch = nextEpoch;
    return true;
  }

  async function admit(envelope, context = {}) {
    return transact(async () => {
      ensureInitialized();
      const existing = operations.get(envelope.commandId);
      const payloadHash = semanticPayloadHash(envelope.payload);
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.type !== envelope.type) {
          throw ledgerError("operation_conflict", {existing: publicRecord(existing)});
        }
        return {duplicate: true, record: publicRecord(existing)};
      }
      if (envelope.type === "prompt" && activeRoot) throw ledgerError("operation_in_progress", {runId: activeRoot.runId});
      const record = createOperationRecord(envelope, {now: now()});
      if (context.parentRunId) record.parentRunId = String(context.parentRunId);
      if (context.runId) record.runId = String(context.runId);
      if (envelope.type === "prompt") {
        activeRoot = {
          runId: record.runId,
          commandId: record.commandId,
          controlEpoch: envelope.controlEpoch,
          runtimeId: envelope.runtimeId,
          executionEpoch: envelope.executionEpoch,
          startedAt: now(),
        };
      }
      operations.set(record.commandId, record);
      trimOperations();
      await persist();
      return {duplicate: false, record: publicRecord(record)};
    });
  }

  async function consumeDispatchPermit(commandId, context = {}) {
    return transact(async () => {
      ensureInitialized();
      const record = requireOperation(commandId);
      if (record.dispatchPermit === "consumed") {
        return {consumed: false, ambiguous: false, record: publicRecord(record)};
      }
      if (context.runtimeId && record.runtimeId !== context.runtimeId) throw ledgerError("stale_runtime");
      if (context.executionEpoch !== undefined && record.executionEpoch !== context.executionEpoch) {
        throw ledgerError("stale_execution_epoch");
      }
      if (context.sessionGeneration !== undefined && record.sessionGeneration !== context.sessionGeneration) {
        throw ledgerError("stale_session_generation");
      }
      record.dispatchPermit = "consumed";
      record.processing = "dispatch_committed";
      record.dispatchEpoch = context.controlEpoch ?? record.controlEpoch;
      record.updatedAt = now();
      await persist();
      return {consumed: true, ambiguous: false, record: publicRecord(record)};
    });
  }

  async function recordEvidence(commandId, evidence) {
    return transact(async () => {
      ensureInitialized();
      const record = requireOperation(commandId);
      const safeEvidence = boundedEvidence(evidence);
      const evidenceId = String(safeEvidence.id || `${safeEvidence.type || "event"}-${now()}`).slice(0, 160);
      if (!record.evidenceIds.includes(evidenceId)) record.evidenceIds.push(evidenceId);
      if (record.dispatchPermit === "consumed") {
        if (["agent_start", "turn_start", "tool_execution_start"].includes(safeEvidence.type)) {
          record.processing = "executing";
        } else if (safeEvidence.type === "input" || safeEvidence.type === "message_start") {
          record.processing = "invocation_observed";
        } else if (["handler_failed", "command_failed"].includes(safeEvidence.type) ||
            safeEvidence.summary?.isError === true || safeEvidence.summary?.stopReason === "error") {
          record.processing = "execution_finished";
          record.outcome = "failure";
        } else if (["handler_succeeded", "command_succeeded"].includes(safeEvidence.type)) {
          record.processing = "execution_finished";
          record.outcome = "success";
        } else if (safeEvidence.type === "agent_settled" && record.outcome === "pending") {
          // Quiescence is not a command result. Keep the operation explicitly uncertain.
          record.processing = "outcome_unknown";
          record.outcome = "unknown";
        }
      }
      record.updatedAt = now();
      await persist();
      return publicRecord(record);
    });
  }

  async function setOutcome(commandId, outcome, processing = "execution_finished") {
    return update(commandId, {outcome, processing});
  }

  async function setDurability(commandId, durability) {
    return update(commandId, {durability});
  }

  async function update(commandId, updates) {
    return transact(async () => {
      ensureInitialized();
      const record = requireOperation(commandId);
      if (updates.outcome && !["pending", "success", "failure", "canceled", "handed_to_terminal", "unknown"].includes(updates.outcome)) {
        throw ledgerError("invalid_operation_outcome");
      }
      if (updates.processing && !["recorded", "dispatch_committed", "invocation_observed", "executing", "interrupted", "outcome_unknown", "execution_finished"].includes(updates.processing)) {
        throw ledgerError("invalid_processing_state");
      }
      if (updates.durability && !["not_checkpointed", "checkpoint_committed"].includes(updates.durability)) {
        throw ledgerError("invalid_durability_state");
      }
      Object.assign(record, updates, {updatedAt: now()});
      await persist();
      return publicRecord(record);
    });
  }

  async function releaseRoot(runId, options = {}) {
    return transact(async () => {
      if (!activeRoot || activeRoot.runId !== String(runId || "")) return false;
      if (!options.force && options.commandId && activeRoot.commandId !== options.commandId) return false;
      activeRoot = null;
      await persist();
      return true;
    });
  }

  async function event(type, data = {}) {
    return transact(async () => {
      const sequence = (events.at(-1)?.sequence || 0) + 1;
      const item = {
        sequence,
        type: String(type || "session_event").slice(0, 64),
        data: boundedObject(data),
        createdAt: now(),
      };
      events.push(item);
      while (events.length > maxEvents) events.shift();
      await persist();
      return {...item};
    });
  }

  function get(commandId) {
    const record = operations.get(String(commandId || ""));
    return record ? publicRecord(record) : null;
  }

  function list() {
    return [...operations.values()].map(publicRecord);
  }

  function snapshot() {
    return {
      activeRoot: activeRoot ? {...activeRoot} : null,
      runtimeId,
      executionEpoch,
      operations: list().slice(-64),
      events: events.slice(-64).map((item) => ({...item})),
    };
  }

  async function transact(callback) {
    const previous = queue;
    let resolveQueue;
    queue = new Promise((resolve) => { resolveQueue = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      resolveQueue();
    }
  }

  async function persist() {
    await store.save({
      runtimeId,
      executionEpoch,
      operations: [...operations.values()].map(publicRecord),
      activeRoot: activeRoot ? {...activeRoot} : null,
      events: events.map((item) => ({...item})),
    });
  }

  function ensureInitialized() {
    if (!initialized) throw ledgerError("operation_ledger_not_ready");
  }

  function requireOperation(commandId) {
    const record = operations.get(String(commandId || ""));
    if (!record) throw ledgerError("operation_not_found");
    return record;
  }

  function trimOperations() {
    while (operations.size > maxOperations) operations.delete(operations.keys().next().value);
  }
}

function createMemoryOperationStore(initial = {}) {
  let state = clone(initial);
  return {
    async load() { return clone(state); },
    async save(next) { state = clone(next); },
  };
}

function createFileOperationStore({filePath, fsModule = fs} = {}) {
  if (!filePath) throw new Error("File operation store requires a path.");
  return {
    async load() {
      try {
        return JSON.parse(await fsModule.promises.readFile(filePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return {};
        throw error;
      }
    },
    async save(value) {
      await fsModule.promises.mkdir(path.dirname(filePath), {recursive: true});
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await fsModule.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {mode: 0o600});
      await fsModule.promises.rename(temporaryPath, filePath);
    },
  };
}

function publicRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function sanitizeRecord(record) {
  return {
    ...publicRecord(record),
    evidenceIds: Array.isArray(record.evidenceIds) ? record.evidenceIds.slice(0, 64) : [],
  };
}

function boundedEvidence(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    id: String(source.id || "").slice(0, 160),
    type: String(source.type || "event").slice(0, 64),
    sessionGeneration: Number.isSafeInteger(source.sessionGeneration) ? source.sessionGeneration : null,
    piSession: String(source.piSession || "").slice(0, 256),
    summary: boundedObject(source.summary),
  };
}

function boundedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [
    String(key).slice(0, 64),
    typeof item === "string" ? item.slice(0, 4000) : typeof item === "number" || typeof item === "boolean" ? item : null,
  ]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function ledgerError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  MAX_EVENTS,
  MAX_OPERATIONS,
  createFileOperationStore,
  createMemoryOperationStore,
  createOperationLedger,
};
