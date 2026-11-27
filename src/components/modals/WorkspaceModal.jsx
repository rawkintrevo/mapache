import {DEFAULT_REMOTE_RESOURCES, RemoteVmResourceFields} from "../workspaces/RemoteVmResourceFields.jsx";
import {Plus, X} from "lucide-react";
import {useEffect, useMemo, useState} from "react";
import {parseEnvText} from "../../utils/envText.js";
import {isReadyRemoteHost} from "../../utils/workspaceProvider.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceModal({
  onClose,
  onConnectGithub,
  onCreateWorkspace,
  onLoadConnectedRepos,
  onLoadRemoteHosts,
  onShowRemoteHosts,
  repoPicker,
  remoteHostState,
  environmentEntries = [],
}) {
  const [sourceType, setSourceType] = useState("blank");
  const [manualRepoUrl, setManualRepoUrl] = useState("");
  const [selectedRepoKey, setSelectedRepoKey] = useState("");
  const isGithub = sourceType === "github";
  const [resources, setResources] = useState(DEFAULT_REMOTE_RESOURCES);
  const isRemoteVm = sourceType === "remote-libvirt";
  const repos = repoPicker && Array.isArray(repoPicker.repos) ? repoPicker.repos : [];
  const remoteHosts = remoteHostState && Array.isArray(remoteHostState.hosts) ? remoteHostState.hosts : [];
  const remoteVmAdmissionEnabled = remoteHostState?.remoteVmAdmissionEnabled === true;
  const readyRemoteHost = remoteHosts.find(isReadyRemoteHost) || null;
  const selectedRepo = useMemo(
      () => repos.find((repo) => connectedRepoKey(repo) === selectedRepoKey) || null,
      [repos, selectedRepoKey],
  );

  useEffect(() => {
    if (isGithub && onLoadConnectedRepos) {
      onLoadConnectedRepos();
    }
  }, [isGithub, onLoadConnectedRepos]);

  useEffect(() => {
    if (onLoadRemoteHosts) void onLoadRemoteHosts();
  }, [onLoadRemoteHosts]);

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="workspace-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="workspace-modal-title">Create Workspace</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const branch = formData.get("branch");
            const repoUrl = manualRepoUrl;
            const source = isRemoteVm ? {
              type: "remote-libvirt",
              hostId: readyRemoteHost?.id || readyRemoteHost?.hostId || "",
            } : selectedRepo ? {
              type: "github",
              mode: "connected",
              installationId: selectedRepo.installationId,
              repoId: selectedRepo.repoId,
              owner: selectedRepo.owner,
              repo: selectedRepo.name,
              repoUrl: selectedRepo.cloneUrl || selectedRepo.repoUrl,
              requestedBranch: branch || selectedRepo.defaultBranch,
            } : {
              type: sourceType,
              repoUrl,
              requestedBranch: branch,
            };
            const environmentEntryIds = formData.getAll("environmentEntryId");
            const workspacePayload = {
              name: formData.get("name"),
              ...(isRemoteVm ? {resources} : {}),
              source,
              repoUrl,
              branch,
              env: parseEnvText(formData.get("env")),
            };
            if (environmentEntryIds.length) workspacePayload.environmentEntryIds = environmentEntryIds;
            onCreateWorkspace(workspacePayload);
            onClose();
          }}
        >
          <label><span>Workspace Name</span><input autoComplete="off" name="name" placeholder="default" required /></label>
          <div aria-label="Workspace source" className="workspace-source-choice" role="radiogroup">
            <label className="source-choice">
              <input
                checked={sourceType === "blank"}
                name="workspaceSource"
                type="radio"
                value="blank"
                onChange={() => {
                  setSourceType("blank");
                  setSelectedRepoKey("");
                }}
              />
              <span>Blank</span>
            </label>
            <label className="source-choice">
              <input
                checked={isGithub}
                name="workspaceSource"
                type="radio"
                value="github"
                onChange={() => setSourceType("github")}
              />
              <span>GitHub</span>
            </label>
            <label className="source-choice">
              <input
                checked={isRemoteVm}
                disabled={!remoteVmAdmissionEnabled}
                aria-describedby="workspace-remote-vm-admission-help"
                name="workspaceSource"
                type="radio"
                value="remote-libvirt"
                onChange={() => {
                  setSourceType("remote-libvirt");
                  setSelectedRepoKey("");
                }}
              />
              <span>VM on remote machine</span>
            </label>
          </div>
          {!remoteVmAdmissionEnabled ? (
            <p className="subtle" id="workspace-remote-vm-admission-help" role="status">
              {remoteHostState?.loading ? "Checking remote VM availability..." : remoteHostState?.attempted ? "Remote VM workspace creation is currently disabled." : "Checking remote VM availability..."}
            </p>
          ) : null}
          {isGithub ? (
            <div className="workspace-source-fields">
              <div className="repo-picker">
                {repoPicker && repoPicker.error ? <p className="error">{repoPicker.error}</p> : null}
                {repos.length ? (
                  <label>
                    <span>Connected Repository</span>
                    <select
                      name="connectedRepo"
                      value={selectedRepoKey}
                      onChange={(event) => setSelectedRepoKey(event.target.value)}
                    >
                      <option value="">Use repository URL</option>
                      {repos.map((repo) => {
                        const key = connectedRepoKey(repo);
                        return (
                          <option key={key} value={key}>
                            {repo.fullName}{repo.private ? " private" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                ) : (
                  <Button
                    className="github-connect-button"
                    disabled={repoPicker && repoPicker.loading}
                    type="button"
                    variant="secondary"
                    onClick={onConnectGithub}
                  >
                    Connect GitHub
                  </Button>
                )}
                {repoPicker && repoPicker.loading ? <p className="repo-picker-fallback">Loading connected repositories...</p> : null}
              </div>
              <label>
                <span>Repository URL</span>
                <input
                  autoComplete="off"
                  disabled={Boolean(selectedRepo)}
                  inputMode="url"
                  name="repoUrl"
                  placeholder="https://github.com/owner/repo"
                  required={isGithub && !selectedRepo}
                  type="url"
                  value={selectedRepo ? selectedRepo.repoUrl || selectedRepo.cloneUrl || "" : manualRepoUrl}
                  onChange={(event) => {
                    setManualRepoUrl(event.target.value);
                    setSelectedRepoKey("");
                  }}
                />
              </label>
              <label>
                <span>Branch</span>
                <input
                  autoComplete="off"
                  name="branch"
                  placeholder={selectedRepo ? selectedRepo.defaultBranch || "default branch" : "default branch"}
                />
              </label>
            </div>
          ) : null}
          {isRemoteVm ? (
            <section aria-label="Remote VM settings" className="workspace-remote-vm-fields">
              <div>
                <strong>Remote VM resources</strong>
                <RemoteVmResourceFields resources={resources} onChange={setResources} />
              </div>
              <dl className="workspace-remote-vm-specs">
                <div><dt>Host</dt><dd>{readyRemoteHost ? readyRemoteHost.displayName || readyRemoteHost.address : "No ready host"}</dd></div>
                <div><dt>Guest</dt><dd>Ubuntu 24.04 · pi-web-ui</dd></div>
                <div><dt>Disk</dt><dd>40 GiB</dd></div>
              </dl>
              {remoteHostState?.loading ? <p className="subtle" role="status">Loading remote host…</p> : null}
              {!remoteHostState?.loading && !readyRemoteHost ? (
                <div className="workspace-remote-host-warning" role="alert">
                  <p>{remoteHosts.length ? "The configured host is not ready yet. Finish setup and verify its connection before creating a remote VM." : "Set up a remote host before creating a remote VM workspace."}</p>
                  <Button type="button" variant="secondary" onClick={onShowRemoteHosts}>Set up remote host</Button>
                </div>
              ) : null}
            </section>
          ) : null}
          {!isRemoteVm ? <div className="workspace-remote-host-callout">
            <div>
              <strong>Using a home machine?</strong>
              <p className="subtle">Set up its restricted SSH connection before choosing the remote VM workspace option.</p>
            </div>
            <Button type="button" variant="secondary" onClick={onShowRemoteHosts}>Set up remote host</Button>
          </div> : null}
          <label>
            <span>Workspace env</span>
            <textarea name="env" placeholder={"FOO=workspace-value\nNODE_ENV=development"} rows={4} />
          </label>
          {environmentEntries.length ? <fieldset><legend>Saved generic environment keys</legend>{environmentEntries.map((entry) => <label className="checkbox-label" key={entry.id}><input name="environmentEntryId" type="checkbox" value={entry.id} /><span>{entry.label || entry.name} ({entry.name})</span></label>)}</fieldset> : null}
          <Button disabled={isRemoteVm && (!remoteVmAdmissionEnabled || !readyRemoteHost)} type="submit">
            <Plus aria-hidden="true" />
            Create Workspace
          </Button>
        </form>
      </section>
    </ModalBackdrop>
  );
}

function connectedRepoKey(repo) {
  return `${repo.installationId || ""}:${repo.repoId || repo.fullName || repo.repoUrl || ""}`;
}
