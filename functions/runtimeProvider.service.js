"use strict";

const {
  CLOUD_RUN_BACKEND,
  COMPUTE_ENGINE_BACKEND,
  REMOTE_LIBVIRT_BACKEND,
  isComputeEngineRuntime,
  isRemoteLibvirtRuntime,
  isRuntimeProviderEnabled,
  runtimeDescriptorForSession,
} = require("./runtimeProvider.helpers");

function createRuntimeProviderService({cloudRunService, computeEngineService, remoteVmService, env = process.env, logger = console} = {}) {
  if (!cloudRunService) throw new Error("cloud_run_provider_required");

  return {
    descriptorForSession: (workspace, session) => runtimeDescriptorForSession(workspace, session),
    isEnabled: () => isRuntimeProviderEnabled(env),
    provisionSessionService: (workspace, sessionRef, session, options) => dispatch("provisionSessionService", workspace, sessionRef, session, options),
    patchSessionService: (sessionRef, session, options) => dispatch("patchSessionService", null, sessionRef, session, options),
    deleteSessionService: (sessionRef, session, options) => dispatch("deleteSessionService", null, sessionRef, session, options),
    providerForSession: (workspace, session) => {
      const descriptor = runtimeDescriptorForSession(workspace, session);
      if (isRemoteLibvirtRuntime(descriptor)) return remoteVmService;
      return isComputeEngineRuntime(descriptor) ? computeEngineService : cloudRunService;
    },
  };

  async function dispatch(operation, workspace, sessionRef, session, options = {}) {
    const descriptor = runtimeDescriptorForSession(workspace || {}, session || {});
    if (descriptor.backend === COMPUTE_ENGINE_BACKEND) {
      if (!computeEngineService) throw new Error("compute_engine_provider_unavailable");
      try {
        if (operation === "provisionSessionService") return await computeEngineService.provisionSessionService(workspace, sessionRef, session, options);
        return await computeEngineService[operation](sessionRef, session, options);
      } catch (error) {
        logger.error?.("compute engine runtime operation failed", {operation, code: error.code || "runtime_provider_failed"});
        throw error;
      }
    }
    if (descriptor.backend === REMOTE_LIBVIRT_BACKEND) {
      if (!remoteVmService) throw new Error("remote_libvirt_provider_unavailable");
      try {
        if (operation === "provisionSessionService") return await remoteVmService.provisionSessionService(workspace, sessionRef, session, options);
        return await remoteVmService[operation](sessionRef, session, options);
      } catch (error) {
        logger.error?.("remote libvirt runtime operation failed", {operation, code: error.code || "runtime_provider_failed"});
        throw error;
      }
    }
    if (operation === "provisionSessionService") {
      return cloudRunService.provisionSessionService(workspace, sessionRef, session);
    }
    return cloudRunService[operation](sessionRef, session, options);
  }
}

function runtimeBackendForNewWorkspace({enabled = false} = {}) {
  return enabled ? COMPUTE_ENGINE_BACKEND : CLOUD_RUN_BACKEND;
}

module.exports = {createRuntimeProviderService, runtimeBackendForNewWorkspace};
