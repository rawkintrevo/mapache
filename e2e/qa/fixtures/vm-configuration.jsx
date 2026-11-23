import React from "react";
import {createRoot} from "react-dom/client";
import {ModalStack} from "/src/components/modals/ModalStack.jsx";
import {withVmWorkspaces} from "/src/services/vmWorkspaceApi.js";
import "/src/styles.css";

const workspace = {id: "vm", name: "VM configuration fixture", backend: "compute-engine", state: "stopped", generation: 11};
let config = {generation: 11, desiredVersion: 2, appliedVersion: 2, state: "applied", restartRequired: false,
  desired: {authSelection: {harness: "pi", providers: {}}, environmentEntryIds: []}};
window.vmProof = {legacyCalls: 0, actions: [], errors: []};
window.vmConfigurationFixture = {
  advance: () => { config.desiredVersion++; },
  apply: () => { config.appliedVersion = config.desiredVersion; config.state = "applied"; config.restartRequired = false; },
};
const forbidden = () => { window.vmProof.legacyCalls++; throw new Error("legacy VM call"); };
const api = withVmWorkspaces({getWorkspaces: async () => ({workspaces: []}),
  getMachineConfiguration: forbidden, updateMachineConfiguration: forbidden,
  getPiAuth: async () => ({entries: {key: {providerKey: "openai", label: "Work account", credential: {key: "fixture-secret-never-render"}}}}),
  getGenericEnvironmentKeys: async () => ({entries: [{id: "env", name: "SERVICE_KEY", label: "Service"}]}),
}, async (url, options) => {
  if (url.endsWith("/workspaces")) return {workspaces: [workspace]};
  if (!url.endsWith("/configuration")) throw new Error("unexpected VM route");
  if (options?.method === "PATCH") {
    window.vmProof.actions.push(options.body);
    if (options.body.expectedVersion !== config.desiredVersion) throw new Error("vm_configuration_version_mismatch");
    config = {...config, desiredVersion: config.desiredVersion + 1, state: "pending-restart", restartRequired: true,
      desired: {authSelection: options.body.authSelection, environmentEntryIds: options.body.environmentEntryIds}};
  }
  return structuredClone(config);
});
await api.getWorkspaces();
createRoot(document.getElementById("root")).render(<ModalStack
  selectedWorkspace={workspace} state={{api, workspaceEditModalOpen: true, pendingOperations: {}}}
  handlers={{github: {}, google: {}, pi: {}, workspaces: {}, modals: {closeWorkspaceEditModal: () => {}}}}
/>);
