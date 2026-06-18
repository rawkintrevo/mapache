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
            const source = selectedRepo ? {
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
