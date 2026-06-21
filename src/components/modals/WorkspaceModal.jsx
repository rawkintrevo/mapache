import {Plus, X} from "lucide-react";
import {useEffect, useMemo, useState} from "react";
import {parseEnvText} from "../../utils/envText.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function WorkspaceModal({
  onClose,
  onConnectGithub,
  onCreateWorkspace,
  onLoadConnectedRepos,
  repoPicker,
}) {
  const [sourceType, setSourceType] = useState("blank");
  const [manualRepoUrl, setManualRepoUrl] = useState("");
  const [selectedRepoKey, setSelectedRepoKey] = useState("");
  const isGithub = sourceType === "github";
  const isSsh = sourceType === "ssh";
  const repos = repoPicker && Array.isArray(repoPicker.repos) ? repoPicker.repos : [];
  const selectedRepo = useMemo(
      () => repos.find((repo) => connectedRepoKey(repo) === selectedRepoKey) || null,
      [repos, selectedRepoKey],
  );

  useEffect(() => {
    if (isGithub && onLoadConnectedRepos) {
      onLoadConnectedRepos();
    }
  }, [isGithub, onLoadConnectedRepos]);

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
            const source = isSsh ? {
              type: "ssh",
              sshTarget: {
                host: String(formData.get("sshHost") || "").trim(),
                port: formData.get("sshPort") || "22",
                username: String(formData.get("sshUsername") || "").trim(),
                initialDirectory: String(formData.get("sshInitialDirectory") || "").trim() || "~",
                authMode: formData.get("sshAuthMode") || "private-key",
                privateKey: String(formData.get("sshPrivateKey") || ""),
                certificate: String(formData.get("sshCertificate") || ""),
                knownHosts: String(formData.get("sshKnownHosts") || ""),
                strictHostKeyChecking: formData.get("sshStrictHostKeyChecking") === "on",
              },
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
            onCreateWorkspace({
              name: formData.get("name"),
              source,
              repoUrl,
              branch,
              env: parseEnvText(formData.get("env")),
            });
            onClose();
          }}
        >
          <label><span>Workspace Name</span><input autoComplete="off" name="name" placeholder="default" required /></label>
          <div className="workspace-source-choice">
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
                checked={isSsh}
                name="workspaceSource"
                type="radio"
                value="ssh"
                onChange={() => {
                  setSourceType("ssh");
                  setSelectedRepoKey("");
                }}
              />
              <span>Dev machine</span>
            </label>
          </div>
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
          {isSsh ? (
            <div className="workspace-source-fields">
              <label><span>Host</span><input autoComplete="off" name="sshHost" placeholder="dev.example.com" required /></label>
              <label><span>Port</span><input autoComplete="off" defaultValue="22" inputMode="numeric" name="sshPort" required /></label>
              <label><span>Username</span><input autoComplete="off" name="sshUsername" placeholder="developer" required /></label>
              <label><span>Initial directory</span><input autoComplete="off" defaultValue="~" name="sshInitialDirectory" /></label>
              <label>
                <span>Authentication</span>
                <select defaultValue="private-key" name="sshAuthMode">
                  <option value="private-key">Private key</option>
                  <option value="certificate">Signed certificate</option>
                </select>
              </label>
              <label>
                <span>Private key</span>
                <textarea autoComplete="off" name="sshPrivateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" required rows={5} />
              </label>
              <label>
                <span>Signed certificate</span>
                <textarea autoComplete="off" name="sshCertificate" placeholder="Only required for signed-certificate auth" rows={3} />
              </label>
              <label>
                <span>Known hosts</span>
                <textarea autoComplete="off" name="sshKnownHosts" placeholder="dev.example.com ssh-ed25519 AAAA..." rows={3} />
              </label>
              <label className="checkbox-label">
                <input defaultChecked={true} name="sshStrictHostKeyChecking" type="checkbox" />
                <span>Strict host key checking</span>
              </label>
            </div>
          ) : null}
          <label>
            <span>Workspace env</span>
            <textarea name="env" placeholder={"FOO=workspace-value\nNODE_ENV=development"} rows={4} />
          </label>
          <Button type="submit">
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
