import {isRemoteVmWorkspace} from "../../utils/workspaceProvider.js";
import {DEFAULT_REMOTE_RESOURCES, RemoteVmResourceFields} from "../workspaces/RemoteVmResourceFields.jsx";
import {Save, X} from "lucide-react";
import {useEffect, useState} from "react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";
import {SessionResourceSelector} from "../sessions/SessionResourceSelector.jsx";
import {getDefaultSessionResources} from "../../utils/sessionResources.js";

const DEFAULT_WORKSPACE_RESOURCES = getDefaultSessionResources();

export function WorkspaceEditModal({busy, error = "", workspace, onClose, onSave, onSaveMachineConfiguration}) {
  const remote = isRemoteVmWorkspace(workspace);
  const defaults = remote ? DEFAULT_REMOTE_RESOURCES : DEFAULT_WORKSPACE_RESOURCES;
  const [name, setName] = useState(workspace.name || "");
  const [resources, setResources] = useState(workspace.resources || defaults);
  const [description, setDescription] = useState(workspace.machineConfig?.desired?.description || "");
  const [diskSizeGb, setDiskSizeGb] = useState(workspace.machineConfig?.desired?.diskSizeGb || "");
  const [idleStopMinutes, setIdleStopMinutes] = useState(workspace.machineConfig?.desired?.idleStopMinutes || "");
  const [environmentEntryIds, setEnvironmentEntryIds] = useState((workspace.machineConfig?.desired?.environmentEntryIds || []).join(", "));
  const [piAuthEntryId, setPiAuthEntryId] = useState(workspace.machineConfig?.desired?.piAuthEntryId || "");
  const [googleConnectionId, setGoogleConnectionId] = useState(workspace.machineConfig?.desired?.googleConnectionId || "");
  const [gatewayId, setGatewayId] = useState(workspace.machineConfig?.desired?.gatewayId || "");

  useEffect(() => {
    setName(workspace.name || "");
    setResources(workspace.resources || defaults);
    setDescription(workspace.machineConfig?.desired?.description || "");
    setDiskSizeGb(workspace.machineConfig?.desired?.diskSizeGb || "");
    setIdleStopMinutes(workspace.machineConfig?.desired?.idleStopMinutes || "");
    setEnvironmentEntryIds((workspace.machineConfig?.desired?.environmentEntryIds || []).join(", "));
    setPiAuthEntryId(workspace.machineConfig?.desired?.piAuthEntryId || "");
    setGoogleConnectionId(workspace.machineConfig?.desired?.googleConnectionId || "");
    setGatewayId(workspace.machineConfig?.desired?.gatewayId || "");
  }, [workspace.id, workspace.name, workspace.resources?.cpu, workspace.resources?.memory, workspace.machineConfig?.desiredVersion, workspace.machineConfig?.desired?.diskSizeGb]);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="workspace-edit-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="workspace-edit-modal-title">Edit workspace</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <form
          className="modal-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const saved = await onSave(workspace.id, {name: name.trim(), resources});
            if (saved) {
              let machineConfigSaved = true;
              if (!remote && onSaveMachineConfiguration) {
                machineConfigSaved = await onSaveMachineConfiguration(workspace.id, {
                  expectedVersion: workspace.machineConfig?.desiredVersion,
                  description: description.trim(),
                  resources,
                  diskSizeGb: diskSizeGb === "" ? null : Number(diskSizeGb),
                  idleStopMinutes: idleStopMinutes === "" ? null : Number(idleStopMinutes),
                  environmentEntryIds: environmentEntryIds.split(",").map((value) => value.trim()).filter(Boolean),
                  piAuthEntryId: piAuthEntryId.trim() || null,
                  googleConnectionId: googleConnectionId.trim() || null,
                  gatewayId: gatewayId.trim() || null,
                });
              }
              if (machineConfigSaved !== false) onClose();
            }
          }}
        >
          <label>
            <span>Name</span>
            <input
              autoComplete="off"
              autoFocus
              maxLength={256}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {remote ? <>
            <RemoteVmResourceFields resources={resources} onChange={setResources} />
            <p>Changes apply the next time you start the guest. Stop a running guest first.</p>
          </> : <>
            <SessionResourceSelector
              cpu={resources.cpu}
              cpuName="workspaceCpu"
              memory={resources.memory}
              memoryName="workspaceMemory"
              onChange={setResources}
              sizeName="workspaceSize"
            />
            <label>
              <span>Description</span>
              <textarea maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label>
              <span>Durable disk size (GiB, 10–4096)</span>
              <input inputMode="numeric" min="10" max="4096" type="number" value={diskSizeGb} onChange={(event) => setDiskSizeGb(event.target.value)} />
            </label>
            <label>
              <span>Idle stop minutes (5–1440)</span>
              <input inputMode="numeric" min="5" max="1440" type="number" value={idleStopMinutes} onChange={(event) => setIdleStopMinutes(event.target.value)} />
            </label>
            <label>
              <span>Environment entry IDs</span>
              <input autoComplete="off" placeholder="env-entry-id, another-entry-id" value={environmentEntryIds} onChange={(event) => setEnvironmentEntryIds(event.target.value)} />
            </label>
            <label>
              <span>Pi auth entry ID</span>
              <input autoComplete="off" value={piAuthEntryId} onChange={(event) => setPiAuthEntryId(event.target.value)} />
            </label>
            <label>
              <span>Google Workspace connection ID</span>
              <input autoComplete="off" value={googleConnectionId} onChange={(event) => setGoogleConnectionId(event.target.value)} />
            </label>
            <label>
              <span>Gateway ID</span>
              <input autoComplete="off" value={gatewayId} onChange={(event) => setGatewayId(event.target.value)} />
            </label>
          </>}
          <div className="modal-form-actions">
            <Button disabled={busy || !name.trim()} type="submit">
              <Save aria-hidden="true" />
              Save changes
            </Button>
            <Button disabled={busy} type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </section>
    </ModalBackdrop>
  );
}
