"use strict";

const crypto = require("node:crypto");
const {resolveAllowedAddresses} = require("./remoteHost.service");
const {runRemoteHostCommand} = require("./remoteHost.connection");
const {guestConfiguration, guestConfigurationId} = require("./remoteVmGuestConfig.helpers");
const {httpError} = require("./backendUtils.helpers");
const {sessionStatusUpdate} = require("./sessionLifecycle.helpers");
const {runtimeSessionStateUpdate} = require("./runtimeReservation.helpers");
const {
  REMOTE_GUEST_DISK_GIB,
  REMOTE_GUEST_IMAGE_VERSION,
  REMOTE_GUEST_MEMORY_MIB,
  REMOTE_GUEST_VCPUS,
  REMOTE_LIBVIRT_BACKEND,
  normalizeRuntimeDescriptor,
  remoteDiskName,
  remoteGuestName,
} = require("./runtimeProvider.helpers");

const GIB = 1024 ** 3;
const HEADROOM = Object.freeze({
  vcpus: 1,
  memoryBytes: GIB,
  diskBytes: 5 * GIB,
});
const RETRYABLE_HOST_CODES = new Set([
  "remote_host_unreachable",
  "remote_host_connection_unavailable",
  "remote_vm_transport_unavailable",
  "remote_vm_response_lost",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function lifecycleError(code, message = code, details = {}) {
  const error = httpError(409, code);
  error.code = code;
  error.publicMessage = code;
  error.message = message;
  Object.assign(error, details);
  return error;
}

function applyResult(kind, operation, session = {}) {
  const result = operation?.result || operation?.observed || {};
  return {
    ...result,
    id: operation?.id || null,
    operationId: operation?.id || null,
    kind,
    state: operation?.state || result.state || "unknown",
    workspaceId: session.workspaceId || operation?.workspaceId || null,
  };
}

function createRemoteVmLifecycleService(dependencies = {}) {
  const db = dependencies.db;
  if (!db || typeof db.collection !== "function") throw new Error("remote_vm_lifecycle_db_required");
  const now = dependencies.now || (() => new Date().toISOString());
  const operationRunner = dependencies.hostOperation || defaultHostOperation;

  return Object.freeze({
    create: (workspace, sessionRef, session, options = {}) => runLifecycle("create", workspace, sessionRef, session, options),
    start: (workspace, sessionRef, session, options = {}) => runLifecycle("start", workspace, sessionRef, session, options),
    stop: (sessionRef, session, options = {}) => runLifecycle("stop", null, sessionRef, session, options),
    delete: (sessionRef, session, options = {}) => runLifecycle("delete", null, sessionRef, session, options),
    provisionSessionService: (workspace, sessionRef, session, options = {}) => provisionSessionService(workspace, sessionRef, session, options),
    patchSessionService: (sessionRef, session, options = {}) => patchSessionService(sessionRef, session, options),
    deleteSessionService: (sessionRef, session, options = {}) => deleteSessionService(sessionRef, session, options),
    inspect: (session, options = {}) => inspectSession(session, options),
    reconcileOperation: (operationId, options) => reconcileOperation(operationId, options),
    executeOperation: (operationId) => executeOperation(operationId),
    reserveCapacity: (workspace, descriptor, operationId) => reserveCapacity(workspace, descriptor, operationId),
    releaseCapacity: (descriptor, operationId) => releaseCapacity(descriptor, operationId),
  });

  async function provisionSessionService(workspace, sessionRef, session, options = {}) {
    const result = await runLifecycle("start", workspace, sessionRef, session, options);
    // The operation trigger may acquire the lease before this caller. That is
    // an in-flight start, not evidence that SSH or the guest is unreachable.
    if (["queued", "running"].includes(result.state)) {
      throw lifecycleError("remote_vm_provisioning_pending");
    }
    if (result.state !== "completed") throw lifecycleError(result.errorCode || "remote_vm_unreachable");
    const descriptor = normalizeRuntimeDescriptor(session.runtimeProvider || session.runtimeProviderDescriptor, {
      workspaceId: session.workspaceId || workspace?.id,
      ownerUid: session.ownerUid || workspace?.ownerUid,
    });
    const update = {
      ...runtimeSessionStateUpdate(session, "running"),
      runtimeProviderState: "running",
      runtimeProviderOperationId: result.id || null,
      runtimeInstanceName: descriptor.guestName,
      runtimeDataDiskName: descriptor.dataDiskName,
      runtimeDataDiskGeneration: descriptor.generation,
      serviceUrl: descriptor.gateway?.baseUrl || remoteVmGatewayBaseUrl(),
      remoteCredentialBrokerUrl: typeof dependencies.remoteVmCredentialsUrl === "function" ?
        dependencies.remoteVmCredentialsUrl() : null,
      agentRuntimeBootInstanceId: result.bootId,
      agentRuntimeGeneration: descriptor.generation,
      lastError: null,
      runtimeProvider: {...descriptor, state: "running", guestIp: result.guestIp || descriptor.guestIp},
      ...(session.provisioningOperationId ? {
        provisioningState: "completed",
        provisioningAttemptCompletedAt: now(),
        provisioningRetryable: false,
        provisioningLastError: null,
      } : {}),
      ...(dependencies.admin?.firestore?.Timestamp ? {updatedAt: dependencies.admin.firestore.Timestamp.now()} : {}),
    };
    const statusUpdate = sessionStatusUpdate(session, "running", update, {
      reconciliationReason: "remote_vm_ready",
    });
    if (sessionRef && typeof sessionRef.update === "function") await sessionRef.update(statusUpdate);
    if (typeof dependencies.markChromeWorkspaceSessionRunning === "function") {
      await dependencies.markChromeWorkspaceSessionRunning(sessionRef, {...session, ...update});
    }
    return {...session, ...statusUpdate};
  }

  async function patchSessionService(sessionRef, session, options = {}) {
    if (options.restart || options.start) return provisionSessionService(null, sessionRef, session, options);
    const observed = await inspectSession(session, options);
    const descriptor = normalizeRuntimeDescriptor(session.runtimeProvider || session.runtimeProviderDescriptor, {
      workspaceId: session.workspaceId, ownerUid: session.ownerUid,
    });
    return {...session, runtimeProviderState: observed.state, runtimeProvider: {...descriptor, state: observed.state, guestIp: observed.guestIp}};
  }

  async function deleteSessionService(sessionRef, session, options = {}) {
    if (options.destroy === true || options.deleteWorkspace === true) {
      const result = await runLifecycle("delete", null, sessionRef, session, options);
      if (result.state !== "completed") return false;
      return {serviceAbsent: true, dataDiskRetained: false, operationId: result.id};
    }
    const result = await runLifecycle("stop", null, sessionRef, session, options);
    if (result.state !== "completed") return false;
    return {serviceAbsent: true, dataDiskRetained: true, operationId: result.id};
  }

  async function runLifecycle(kind, suppliedWorkspace, sessionRef, session = {}, options = {}) {
    const context = await resolveContext(suppliedWorkspace, sessionRef, session, options);
    const {workspace, descriptor} = context;
    const operation = await queueOperation(kind, workspace, descriptor,
      {...session, id: sessionRef?.id || session.id || session.runnerSessionId}, options);
    if (operation.state === "completed") return applyResult(kind, operation, session);
    try {
      const completed = await executeOperation(operation.id);
      return applyResult(kind, completed, session);
    } catch (error) {
      const current = await operationRef(operation.id).get().catch(() => null);
      const currentData = current?.exists ? current.data() || {} : {};
      if (isHostUnavailable(error)) {
        return applyResult(kind, {
          ...currentData,
          id: operation.id,
          state: "unreachable",
          errorCode: error.code || "remote_host_unreachable",
        }, session);
      }
      throw error;
    }
  }

  async function resolveContext(suppliedWorkspace, sessionRef, session, options) {
    const workspaceId = String(session.workspaceId || suppliedWorkspace?.id || options.workspaceId || "").trim();
    if (!workspaceId) throw lifecycleError("remote_vm_workspace_required");
    const workspaceSnap = suppliedWorkspace ? {exists: true, data: () => suppliedWorkspace} :
      await db.collection("workspaces").doc(workspaceId).get();
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const workspace = suppliedWorkspace || workspaceSnap.data() || {};
    const ownerUid = String(session.ownerUid || workspace.ownerUid || options.ownerUid || "").trim();
    if (!ownerUid) throw lifecycleError("remote_vm_owner_required");
    if (workspace.ownerUid && workspace.ownerUid !== ownerUid) throw httpError(403, "workspace_forbidden");
    const descriptor = normalizeRuntimeDescriptor(
        session.runtimeProvider || session.runtimeProviderDescriptor || workspace.runtimeProvider || workspace.runtimeProviderDescriptor,
        {workspaceId, ownerUid},
    );
    if (descriptor.backend !== REMOTE_LIBVIRT_BACKEND) throw lifecycleError("remote_vm_provider_mismatch");
    if (options.deleteWorkspace !== true && (workspace.deleted === true ||
        ["deleting", "deleted"].includes(String(workspace.lifecycle || "").toLowerCase()))) {
      throw lifecycleError("workspace_deleted");
    }
    return {workspace: {...workspace, id: workspaceId, ownerUid}, descriptor, workspaceId, ownerUid};
  }

  async function queueOperation(kind, workspace, descriptor, session, options) {
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey || session.provisioningOperationId ||
      session.restartNonce || `${kind}:${descriptor.workspaceId}:${descriptor.generation}`);
    const id = operationId(descriptor.ownerUid, descriptor.workspaceId, kind, idempotencyKey);
    const ref = operationRef(id);
    let result;
    await db.runTransaction(async (transaction) => {
      const existingSnap = await transaction.get(ref);
      if (existingSnap.exists) {
        const existing = {...existingSnap.data(), id};
        if (existing.ownerUid !== descriptor.ownerUid || existing.workspaceId !== descriptor.workspaceId || existing.kind !== kind) {
          throw lifecycleError("remote_vm_operation_conflict");
        }
        if (existing.state === "completed") {
          result = existing;
          return;
        }
        if (["queued", "running"].includes(existing.state)) {
          result = existing;
          return;
        }
      }

      const workspaceRef = db.collection("workspaces").doc(descriptor.workspaceId);
      const workspaceSnap = await transaction.get(workspaceRef);
      if (!workspaceSnap.exists || workspaceSnap.data()?.ownerUid !== descriptor.ownerUid) {
        throw httpError(404, "workspace_not_found");
      }
      const current = workspaceSnap.data() || {};
      if (options.deleteWorkspace !== true && (current.deleted === true || ["deleting", "deleted"].includes(String(current.lifecycle || "").toLowerCase()))) {
        throw lifecycleError("workspace_deleted");
      }
      const activeOperationId = String(current.runtimeProviderOperationId || "").trim();
      if (activeOperationId && activeOperationId !== id) {
        const activeRef = operationRef(activeOperationId);
        const activeSnap = await transaction.get(activeRef);
        const active = activeSnap.exists ? activeSnap.data() || {} : {};
        if (["queued", "running"].includes(String(active.state || ""))) {
          throw lifecycleError("remote_vm_operation_in_progress");
        }
      }
      const hostRef = db.collection("remoteHosts").doc(descriptor.hostId);
      const hostSnap = await transaction.get(hostRef);
      if (!hostSnap.exists || hostSnap.data()?.ownerUid !== descriptor.ownerUid || hostSnap.data()?.deletedAt) {
        throw httpError(404, "remote_host_not_found");
      }
      const host = hostSnap.data() || {};
      if (host.status !== "ready" || host.ready !== true) throw lifecycleError("remote_host_not_ready");

      const needsCapacity = kind === "create" || kind === "start";
      if (needsCapacity) reserveCapacityInTransaction(transaction, hostRef, host, descriptor, id);
      const timestamp = now();
      const targetState = kind === "delete" ? "deleting" : kind === "stop" ? "stopping" : "starting";
      const operationData = {
        ownerUid: descriptor.ownerUid,
        workspaceId: descriptor.workspaceId,
        sessionId: session.id || null,
        sessionBootId: session.agentRuntimeBootInstanceId || null,
        hostId: descriptor.hostId,
        kind,
        idempotencyKey,
        state: "queued",
        attempt: 0,
        capacityReserved: needsCapacity,
        targetState: kind === "stop" ? "stopped" : kind === "delete" ? "deleted" : "running",
        guestName: descriptor.guestName || remoteGuestName(descriptor.workspaceId),
        diskName: descriptor.dataDiskName || remoteDiskName(descriptor.workspaceId),
        imageVersion: descriptor.guestImageVersion || REMOTE_GUEST_IMAGE_VERSION,
        providerGeneration: descriptor.generation,
        createdAt: timestamp,
        updatedAt: timestamp,
        leaseUntil: null,
        lastError: null,
      };
      txSet(transaction, ref, operationData);
      txSet(transaction, workspaceRef, {
        runtimeProvider: {...descriptor, state: targetState},
        runtimeProviderState: targetState,
        runtimeProviderOperationId: id,
        ...(kind === "delete" ? {deletionTombstone: {operationId: id, requestedAt: timestamp}, lifecycle: "deleting"} : {}),
        updatedAt: timestamp,
      });
      result = {...operationData, id};
    });
    return result;
  }

  async function executeOperation(id) {
    const ref = operationRef(id);
    const snap = await ref.get();
    if (!snap.exists) throw lifecycleError("remote_vm_operation_not_found");
    const operation = {...snap.data(), id};
    if (operation.state === "completed") return operation;
    if (operation.state === "cancelled") throw lifecycleError("remote_vm_operation_cancelled");
    const claimed = await claimOperation(ref);
    if (!claimed) {
      const latest = await ref.get();
      return {...latest.data(), id};
    }
    const context = await operationContext(operation);
    if (context.stale) return finishOperation(ref, operation, context, {exists: false});
    try {
      let observed;
      if (operation.kind === "create" || operation.kind === "start") {
        await prepareGuestConfiguration(context);
        observed = normalizeObserved(await performHostOperation(context, "inspect"), context.descriptor);
        if (!observed.exists) {
          observed = normalizeObserved(await performHostOperation(context, "create"), context.descriptor);
        }
        if (!observed.exists) throw lifecycleError("remote_vm_create_unverified");
        if (observed.configurationId !== context.configurationId) {
          if (observed.state === "running") {
            observed = normalizeObserved(await performHostOperation(context, "stop"), context.descriptor);
          }
          if (observed.state !== "stopped") throw lifecycleError("remote_vm_stop_unverified");
          observed = normalizeObserved(await performHostOperation(context, "configure"), context.descriptor);
          if (observed.configurationId !== context.configurationId) throw lifecycleError("remote_vm_configuration_unverified");
        }
        if (observed.state !== "running") observed = normalizeObserved(await performHostOperation(context, "start"), context.descriptor);
        if (observed.state !== "running" || !observed.guestIp) throw lifecycleError("remote_vm_start_unverified");
      } else if (operation.kind === "stop") {
        observed = normalizeObserved(await performHostOperation(context, "stop"), context.descriptor);
        if (observed.state !== "stopped") observed = normalizeObserved(await performHostOperation(context, "inspect"), context.descriptor);
        if (observed.state !== "stopped") throw lifecycleError("remote_vm_stop_unverified");
      } else if (operation.kind === "delete") {
        observed = normalizeObserved(await performHostOperation(context, "inspect"), context.descriptor);
        if (observed.exists) {
          if (observed.state === "running") await performHostOperation(context, "stop");
        }
        // A lost response after undefine can leave disks or the seed behind.
        // The helper's destroy action also removes these when the VM is absent.
        await performHostOperation(context, "destroy");
        observed = normalizeObserved(await performHostOperation(context, "inspect"), context.descriptor);
        if (observed.exists) throw lifecycleError("remote_vm_delete_unverified");
      } else {
        throw lifecycleError("remote_vm_operation_invalid");
      }

      const completed = await finishOperation(ref, operation, context, observed || {exists: false});
      return completed;
    } catch (error) {
      const reconciled = await reconcileLostResponse(error, context, operation);
      if (reconciled) return finishOperation(ref, operation, context, reconciled);
      const failed = await failOperation(ref, operation, context, error);
      if (isHostUnavailable(error)) {
        const result = {...failed, state: "unreachable", errorCode: error.code || "remote_host_unreachable"};
        return result;
      }
      throw error;
    }
  }

  async function operationContext(operation) {
    const workspaceSnap = await db.collection("workspaces").doc(operation.workspaceId).get();
    if (!workspaceSnap.exists || (operation.kind !== "delete" && (workspaceSnap.data()?.deleted === true || workspaceSnap.data()?.deletionTombstone))) {
      throw lifecycleError("workspace_deleted");
    }
    const workspace = workspaceSnap.data() || {};
    const descriptor = normalizeRuntimeDescriptor(
        workspace.runtimeProvider || workspace.runtimeProviderDescriptor,
        {workspaceId: operation.workspaceId, ownerUid: operation.ownerUid},
    );
    if (descriptor.hostId !== operation.hostId || descriptor.generation !== operation.providerGeneration) {
      throw lifecycleError("remote_vm_stale_operation");
    }
    if (operation.kind !== "delete" && (workspace.deleted === true || workspace.deletionTombstone)) {
      return {workspace, descriptor, host: {}, privateKey: "", operation, stale: true};
    }
    const hostSnap = await db.collection("remoteHosts").doc(operation.hostId).get();
    if (!hostSnap.exists || hostSnap.data()?.ownerUid !== operation.ownerUid || hostSnap.data()?.deletedAt) {
      throw httpError(404, "remote_host_not_found");
    }
    const privateSnap = await db.collection("users").doc(operation.ownerUid).collection("private")
        .doc("remoteHosts").collection("entries").doc(operation.hostId).get();
    const privateKey = privateSnap.exists ? privateSnap.data()?.privateKey : "";
    if (!privateKey) throw lifecycleError("remote_host_key_revoked");
    const context = {workspace, descriptor, host: hostSnap.data() || {}, privateKey, operation};
    return context;
  }

  async function prepareGuestConfiguration(context) {
    const {operation, descriptor} = context;
    if (!operation.sessionId) throw lifecycleError("remote_vm_session_required");
    const sessionRef = db.collection("workspaces").doc(operation.workspaceId).collection("sessions").doc(operation.sessionId);
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.data() || {};
    if (!sessionSnap.exists || session.ownerUid !== operation.ownerUid || session.deletedAt ||
        session.workspaceId && session.workspaceId !== operation.workspaceId) {
      throw lifecycleError("remote_vm_session_invalid");
    }
    context.bootId = operation.id;
    context.configuration = guestConfiguration({session, sessionId: operation.sessionId, descriptor,
      bootId: context.bootId, ...(dependencies.remoteVmCredentialsUrl ? {brokerUrl: dependencies.remoteVmCredentialsUrl()} : {})});
    context.configurationId = guestConfigurationId(context.configuration);
    await sessionRef.update({agentRuntimeBootInstanceId: context.bootId, agentRuntimeGeneration: descriptor.generation});
  }

  async function performHostOperation(context, action) {
    const result = await operationRunner({
      action,
      host: redactHost(context.host),
      privateKey: context.privateKey,
      ...(action === "configure" ? {configuration: context.configuration} : {}),
      guest: {
        guestName: context.descriptor.guestName,
        diskName: context.descriptor.dataDiskName,
        imageVersion: context.descriptor.guestImageVersion,
        resources: context.descriptor.guestResources,
      },
    }, dependencies);
    return result || {};
  }

  async function reconcileLostResponse(error, context, operation) {
    if (!isLostResponse(error)) return null;
    try {
      const observed = normalizeObserved(await performHostOperation(context, "inspect"), context.descriptor);
      if (operation.kind === "create" || operation.kind === "start") {
        return observed.exists && observed.state === "running" && observed.guestIp &&
          observed.configurationId === context.configurationId ? observed : null;
      }
      if (operation.kind === "stop") return observed.exists && observed.state === "stopped" ? observed : null;
      if (operation.kind === "delete") return !observed.exists ? observed : null;
    } catch {
      return null;
    }
    return null;
  }

  async function finishOperation(ref, operation, context, observed) {
    if (context.bootId) observed = {...observed, bootId: context.bootId};
    const timestamp = now();
    let finished;
    await db.runTransaction(async (transaction) => {
      const currentSnap = await transaction.get(ref);
      if (!currentSnap.exists) return;
      const current = currentSnap.data() || {};
      if (current.state === "completed" || current.state === "cancelled") {
        finished = {...current, id: ref.id};
        return;
      }
      const workspaceRef = db.collection("workspaces").doc(operation.workspaceId);
      const workspaceSnap = await transaction.get(workspaceRef);
      const workspace = workspaceSnap.exists ? workspaceSnap.data() || {} : {};
      const staleDelete = operation.kind !== "delete" && (workspace.deleted === true || workspace.deletionTombstone);
      if (staleDelete) {
        if (current.capacityReserved) {
          await releaseCapacityInTransaction(transaction, db.collection("remoteHosts").doc(operation.hostId), operation.id, operation.workspaceId);
        }
        txSet(transaction, ref, {state: "cancelled", lastError: "remote_vm_stale_operation", updatedAt: timestamp});
        finished = {...current, id: ref.id, state: "cancelled"};
        return;
      }
      const sessionRef = operation.kind === "stop" && operation.sessionId ?
        workspaceRef.collection("sessions").doc(operation.sessionId) : null;
      const sessionSnap = sessionRef ? await transaction.get(sessionRef) : null;
      // Capacity release reads the host before writing it. Do it before any
      // other writes so Firestore's read-before-write transaction rule holds.
      if (operation.kind === "stop" || operation.kind === "delete") {
        await releaseCapacityInTransaction(transaction, db.collection("remoteHosts").doc(operation.hostId),
            operation.id, operation.workspaceId);
      }
      txSet(transaction, ref, {
        state: "completed",
        attempt: Number(current.attempt || 0),
        observed,
        result: observed,
        completedAt: timestamp,
        updatedAt: timestamp,
        lastError: null,
        errorCode: null,
      });
      const stoppedSession = sessionSnap?.data() || {};
      if (sessionSnap?.exists && stoppedSession.ownerUid === operation.ownerUid &&
          (!operation.sessionBootId || operation.sessionBootId === stoppedSession.agentRuntimeBootInstanceId)) {
        txSet(transaction, sessionRef, sessionStatusUpdate(stoppedSession, "stopped", {
          ...runtimeSessionStateUpdate(stoppedSession, "stopped"),
          runtimeProvider: {...context.descriptor, state: "stopped"},
          runtimeProviderState: "stopped", runtimeProviderOperationId: ref.id,
          serviceUrl: null, activeSocketCount: 0, lastError: null, stoppedAt: timestamp, updatedAt: timestamp,
        }, {reconciliationReason: "remote_vm_stop_confirmed"}));
      }
      const targetState = operation.kind === "delete" ? "deleted" : operation.kind === "stop" ? "stopped" : "running";
      if (workspaceSnap.exists) {
        txSet(transaction, workspaceRef, {
          runtimeProvider: {...context.descriptor, state: targetState, guestIp: observed.guestIp || context.descriptor.guestIp},
          runtimeProviderState: targetState,
          runtimeProviderOperationId: ref.id,
          lastError: null,
          ...(operation.kind === "delete" ? {lifecycle: "deleted", deleted: true, deletedAt: timestamp} : {}),
          updatedAt: timestamp,
        });
      }
      finished = {
        ...current,
        id: ref.id,
        state: "completed",
        result: observed,
        observed,
      };
    });
    return finished || {...operation, state: "completed", observed};
  }

  async function failOperation(ref, operation, context, error) {
    const timestamp = now();
    let failed;
    await db.runTransaction(async (transaction) => {
      const currentSnap = await transaction.get(ref);
      if (!currentSnap.exists) return;
      const current = currentSnap.data() || {};
      if (["completed", "cancelled"].includes(current.state)) {
        failed = {...current, id: ref.id};
        return;
      }
      const hostRef = db.collection("remoteHosts").doc(operation.hostId);
      if (current.capacityReserved && operation.kind !== "stop") {
        await releaseCapacityInTransaction(transaction, hostRef, operation.id, operation.workspaceId);
      }
      const state = isHostUnavailable(error) ? "unreachable" : "error";
      const safeError = safeErrorCode(error);
      txSet(transaction, ref, {
        state,
        lastError: safeError,
        errorCode: safeError,
        retryable: isHostUnavailable(error),
        updatedAt: timestamp,
        completedAt: isHostUnavailable(error) ? null : timestamp,
      });
      const workspaceRef = db.collection("workspaces").doc(operation.workspaceId);
      txSet(transaction, workspaceRef, {
        runtimeProviderState: state,
        runtimeProvider: {...context.descriptor, state},
        runtimeProviderOperationId: ref.id,
        lastError: safeError,
        updatedAt: timestamp,
      });
      failed = {...current, id: ref.id, state, errorCode: safeError};
    });
    return failed || {...operation, state: "error", errorCode: safeErrorCode(error)};
  }

  async function claimOperation(ref) {
    let claimed = false;
    await db.runTransaction(async (transaction) => {
      claimed = false;
      const snap = await transaction.get(ref);
      if (!snap.exists) return;
      const current = snap.data() || {};
      if (current.state === "completed") return;
      if (current.state === "cancelled") return;
      const leaseUntil = Date.parse(String(current.leaseUntil || ""));
      if (current.state === "running" && Number.isFinite(leaseUntil) && leaseUntil > Date.now()) return;
      const timestamp = now();
      txSet(transaction, ref, {
        state: "running",
        attempt: Number(current.attempt || 0) + 1,
        leaseUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        updatedAt: timestamp,
      });
      claimed = true;
    });
    return claimed;
  }

  async function inspectSession(session, options = {}) {
    const descriptor = normalizeRuntimeDescriptor(session.runtimeProvider || session.runtimeProviderDescriptor, {
      workspaceId: session.workspaceId,
      ownerUid: session.ownerUid,
    });
    const context = await operationContext({
      workspaceId: descriptor.workspaceId,
      ownerUid: descriptor.ownerUid,
      hostId: descriptor.hostId,
      providerGeneration: descriptor.generation,
      kind: "inspect",
      ...options,
    });
    return normalizeObserved(await performHostOperation(context, "inspect"), descriptor);
  }

  async function reconcileOperation(operationIdValue, options = {}) {
    const id = normalizeOperationId(operationIdValue);
    const snap = await operationRef(id).get();
    if (!snap.exists) throw lifecycleError("remote_vm_operation_not_found");
    const operation = {...snap.data(), id};
    if (["completed", "cancelled"].includes(operation.state)) return operation;
    if (options.retryFailed === false && operation.state === "error" && operation.retryable !== true) return operation;
    return executeOperation(id);
  }

  async function reserveCapacity(workspace, descriptor, operationIdValue) {
    return db.runTransaction(async (transaction) => {
      const hostRef = db.collection("remoteHosts").doc(descriptor.hostId);
      const snap = await transaction.get(hostRef);
      if (!snap.exists || snap.data()?.ownerUid !== descriptor.ownerUid) throw httpError(404, "remote_host_not_found");
      return reserveCapacityInTransaction(transaction, hostRef, snap.data() || {}, descriptor, operationIdValue);
    });
  }

  async function releaseCapacity(descriptor, operationIdValue) {
    return db.runTransaction(async (transaction) => {
      const hostRef = db.collection("remoteHosts").doc(descriptor.hostId);
      await releaseCapacityInTransaction(transaction, hostRef, operationIdValue, descriptor.workspaceId);
      return true;
    });
  }

  function operationRef(id) {
    return db.collection("remoteVmOperations").doc(id);
  }

  function reserveCapacityInTransaction(transaction, hostRef, host, descriptor, operationIdValue) {
    const capacity = host.capacity || {};
    const cpuCount = Number(capacity.cpuCount);
    const memoryBytes = Number(capacity.memoryBytes);
    const freeDiskBytes = Number(capacity.freeDiskBytes);
    if (![cpuCount, memoryBytes, freeDiskBytes].every((value) => Number.isFinite(value) && value >= 0)) {
      throw lifecycleError("remote_host_capacity_unavailable");
    }
    const reserved = host.remoteVmReservations || {};
    const entries = Array.isArray(reserved.entries) ? reserved.entries.filter(Boolean) : [];
    const current = {
      vcpus: Number(reserved.vcpus || 0),
      memoryBytes: Number(reserved.memoryBytes || 0),
      diskBytes: Number(reserved.diskBytes || 0),
      operationIds: Array.isArray(reserved.operationIds) ? reserved.operationIds : [],
    };
    if (current.operationIds.includes(operationIdValue) || entries.some((entry) => entry.operationId === operationIdValue)) {
      return entries.find((entry) => entry.operationId === operationIdValue) || current;
    }
    const required = {
      vcpus: REMOTE_GUEST_VCPUS,
      memoryBytes: REMOTE_GUEST_MEMORY_MIB * 1024 * 1024,
      diskBytes: REMOTE_GUEST_DISK_GIB * GIB,
    };
    if (cpuCount - current.vcpus - required.vcpus < HEADROOM.vcpus ||
        memoryBytes - current.memoryBytes - required.memoryBytes < HEADROOM.memoryBytes ||
        freeDiskBytes - current.diskBytes - required.diskBytes < HEADROOM.diskBytes) {
      throw lifecycleError("remote_vm_capacity_exhausted");
    }
    const nextEntries = [...entries, {
      operationId: operationIdValue,
      workspaceId: descriptor.workspaceId,
      vcpus: required.vcpus,
      memoryBytes: required.memoryBytes,
      diskBytes: required.diskBytes,
      createdAt: now(),
    }];
    const next = {
      vcpus: current.vcpus + required.vcpus,
      memoryBytes: current.memoryBytes + required.memoryBytes,
      diskBytes: current.diskBytes + required.diskBytes,
      operationIds: [...current.operationIds, operationIdValue].slice(-100),
      entries: nextEntries.slice(-100),
      updatedAt: now(),
    };
    txSet(transaction, hostRef, {remoteVmReservations: next, updatedAt: now()});
    return next;
  }

  async function releaseCapacityInTransaction(transaction, hostRef, operationIdValue, workspaceId) {
    const snap = await transaction.get(hostRef);
    if (!snap.exists) return;
    const current = snap.data()?.remoteVmReservations || {};
    const entries = Array.isArray(current.entries) ? current.entries : [];
    const matching = entries.filter((entry) =>
      entry && entry.operationId !== operationIdValue && entry.workspaceId !== workspaceId);
    if (matching.length === entries.length && entries.length > 0) return;
    if (entries.length > 0) {
      txSet(transaction, hostRef, {
        remoteVmReservations: {
          entries: matching,
          vcpus: matching.reduce((sum, entry) => sum + Number(entry.vcpus || 0), 0),
          memoryBytes: matching.reduce((sum, entry) => sum + Number(entry.memoryBytes || 0), 0),
          diskBytes: matching.reduce((sum, entry) => sum + Number(entry.diskBytes || 0), 0),
          updatedAt: now(),
        },
        updatedAt: now(),
      });
      return;
    }
    // Legacy aggregate reservations predate per-workspace entries. Release one
    // fixed reservation only when there is no entry list to avoid over-release.
    const required = {
      vcpus: REMOTE_GUEST_VCPUS,
      memoryBytes: REMOTE_GUEST_MEMORY_MIB * 1024 * 1024,
      diskBytes: REMOTE_GUEST_DISK_GIB * GIB,
    };
    if (Number(current.vcpus || 0) || Number(current.memoryBytes || 0) || Number(current.diskBytes || 0)) {
      txSet(transaction, hostRef, {
        remoteVmReservations: {
          vcpus: Math.max(0, Number(current.vcpus || 0) - required.vcpus),
          memoryBytes: Math.max(0, Number(current.memoryBytes || 0) - required.memoryBytes),
          diskBytes: Math.max(0, Number(current.diskBytes || 0) - required.diskBytes),
          entries: [],
          updatedAt: now(),
        },
        updatedAt: now(),
      });
    }
  }
}

function remoteVmGatewayBaseUrl() {
  const configured = process.env.VM_REMOTE_VM_GATEWAY_BASE_URL || process.env.VM_RUNTIME_GATEWAY_BASE_URL ||
    String(process.env.VM_WORKSPACE_GATEWAY_HOSTS || "").split(",")
        .map((value) => value.trim())
        .find((value) => value && !value.startsWith("backup-recovery---"));
  if (!configured) return null;
  try {
    const url = new URL(String(configured).startsWith("http") ? configured : `https://${configured}`);
    if (url.protocol !== "https:" || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function txSet(transaction, ref, value) {
  if (typeof transaction.set === "function") transaction.set(ref, value, {merge: true});
  else transaction.update(ref, value);
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 256 || /[^A-Za-z0-9_.:-]/.test(key)) throw lifecycleError("remote_vm_idempotency_key_invalid");
  return key;
}

function operationId(ownerUid, workspaceId, kind, idempotencyKey) {
  return `op-${crypto.createHash("sha256").update(`${ownerUid}:${workspaceId}:${kind}:${idempotencyKey}`).digest("hex").slice(0, 40)}`;
}

function normalizeOperationId(value) {
  const id = String(value || "").trim();
  if (!/^op-[a-f0-9]{40}$/.test(id)) throw lifecycleError("remote_vm_operation_invalid");
  return id;
}

function normalizeObserved(value, descriptor) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw lifecycleError("remote_vm_observation_invalid");
  if (value.guestName && value.guestName !== descriptor.guestName) throw lifecycleError("remote_vm_foreign_guest");
  if (value.diskName && value.diskName !== descriptor.dataDiskName) throw lifecycleError("remote_vm_foreign_disk");
  const state = String(value.state || "unknown").toLowerCase();
  return {
    exists: value.exists !== false,
    guestName: descriptor.guestName,
    diskName: descriptor.dataDiskName,
    state: ["running", "stopped", "starting", "stopping", "unknown"].includes(state) ? state : "unknown",
    guestIp: value.guestIp && /^192\.168\.250\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(value.guestIp) ? value.guestIp : null,
    autostart: value.autostart === true ? true : false,
    configurationId: /^[a-f0-9]{64}$/.test(value.configurationId || "") ? value.configurationId : null,
    observedAt: value.observedAt || new Date().toISOString(),
  };
}

function redactHost(host = {}) {
  return {
    hostId: host.hostId || host.id,
    address: host.address,
    port: host.port,
    managedUsername: host.managedUsername,
    hostKeyFingerprint: host.hostKeyFingerprint || null,
  };
}

function safeErrorCode(error) {
  const code = String(error?.publicMessage || error?.code || "remote_vm_operation_failed");
  return /^[A-Za-z0-9_.:-]{1,96}$/.test(code) ? code : "remote_vm_operation_failed";
}

function isHostUnavailable(error) {
  return RETRYABLE_HOST_CODES.has(String(error?.code || "")) || RETRYABLE_HOST_CODES.has(String(error?.publicMessage || ""));
}

function isLostResponse(error) {
  return String(error?.code || "") === "remote_vm_response_lost" || error?.responseLost === true;
}

async function defaultHostOperation({action, host, privateKey, guest, configuration}) {
  if (!privateKey) throw lifecycleError("remote_host_key_revoked");
  if (!host?.address || !host?.hostKeyFingerprint) throw lifecycleError("remote_host_trust_incomplete");
  try {
    const addresses = await resolveAllowedAddresses(host.address);
    return await runRemoteHostCommand({host, addresses, privateKey, action, guestName: guest?.guestName, configuration});
  } catch (error) {
    throw lifecycleError(error?.publicMessage || "remote_vm_transport_unavailable");
  }
}

module.exports = {
  GIB,
  HEADROOM,
  createRemoteVmLifecycleService,
  isHostUnavailable,
  normalizeObserved,
  operationId,
  remoteDiskName,
  remoteGuestName,
};
