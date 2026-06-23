import {Plus, X} from "lucide-react";
import {useEffect, useState} from "react";
import {sessionImages} from "../../config/sessionImages.js";
import {parseEnvText} from "../../utils/envText.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

const cpuOptions = ["2", "4"];
const memoryOptions = ["2Gi", "4Gi", "8Gi"];

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

export function SessionModal({busy, error = "", selectedWorkspace = null, onClose, onCreateSession}) {
  const workspaceSsh = selectedWorkspace?.source?.type === "ssh";
  const [sessionType, setSessionType] = useState(workspaceSsh ? "ssh" : "cloud");
  const [sshAuthMode, setSshAuthMode] = useState("private-key");
  const [sshStrictHostKeyChecking, setSshStrictHostKeyChecking] = useState(false);
  useEffect(() => {
    setSessionType(workspaceSsh ? "ssh" : "cloud");
  }, [workspaceSsh]);
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="session-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="session-modal-title">New session</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const base = {
              name: String(formData.get("name") || "").trim() || "Terminal session",
              sessionType,
              cpu: formData.get("cpu"),
              memory: formData.get("memory"),
              env: parseEnvText(formData.get("env")),
            };
            onCreateSession(sessionType === "ssh" ? {
              ...base,
              ...(workspaceSsh ? {} : {sshTarget: {
                host: String(formData.get("sshHost") || "").trim(),
                port: formData.get("sshPort") || "22",
                username: String(formData.get("sshUsername") || "").trim(),
                initialDirectory: String(formData.get("sshInitialDirectory") || "").trim() || "~",
                authMode: sshAuthMode,
                privateKey: String(formData.get("sshPrivateKey") || ""),
                certificate: sshAuthMode === "certificate" ? String(formData.get("sshCertificate") || "") : "",
                knownHosts: sshStrictHostKeyChecking ? String(formData.get("sshKnownHosts") || "") : "",
                strictHostKeyChecking: sshStrictHostKeyChecking,
              }}),
            } : {
              ...base,
              imageKey: formData.get("imageKey"),
            });
          }}
        >
          <label><span>Name</span><input autoComplete="off" name="name" placeholder="shell" required /></label>
          <input type="hidden" name="sessionType" value={sessionType} />
          {sessionType === "cloud" ? (
            <label>
              <span>Container image</span>
              <select name="imageKey" defaultValue={sessionImages[0]?.key}>
                {sessionImages.map((image) => <option key={image.key} value={image.key}>{image.label}</option>)}
              </select>
            </label>
          ) : workspaceSsh ? (
            <div className="workspace-source-fields">
              <p className="subtle">
                This session will connect to {selectedWorkspace.source?.target?.username}@{selectedWorkspace.source?.target?.host}.
              </p>
            </div>
          ) : (
            <>
              <label><span>Host</span><input autoComplete="off" name="sshHost" placeholder="dev.example.com" required /></label>
              <label><span>Port</span><input autoComplete="off" defaultValue="22" inputMode="numeric" name="sshPort" required /></label>
              <label><span>Username</span><input autoComplete="off" name="sshUsername" placeholder="developer" required /></label>
              <label><span>Initial directory</span><input autoComplete="off" defaultValue="~" name="sshInitialDirectory" /></label>
              <label>
                <span>Authentication</span>
                <select name="sshAuthMode" value={sshAuthMode} onChange={(event) => setSshAuthMode(event.target.value)}>
                  <option value="private-key">Private key</option>
                  <option value="certificate">Signed certificate</option>
                </select>
              </label>
              <label>
                <span>Private key</span>
                <textarea autoComplete="off" name="sshPrivateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" required rows={5} />
              </label>
              {sshAuthMode === "certificate" ? (
                <label>
                  <span>Signed certificate</span>
                  <textarea autoComplete="off" name="sshCertificate" placeholder="ssh-ed25519-cert-v01@openssh.com ..." required rows={3} />
                </label>
              ) : null}
              <label className="checkbox-label">
                <input
                  checked={sshStrictHostKeyChecking}
                  name="sshStrictHostKeyChecking"
                  type="checkbox"
                  onChange={(event) => setSshStrictHostKeyChecking(event.target.checked)}
                />
                <span>Strict host key checking</span>
              </label>
              {sshStrictHostKeyChecking ? (
                <label>
                  <span>Known hosts</span>
                  <textarea autoComplete="off" name="sshKnownHosts" placeholder="dev.example.com ssh-ed25519 AAAA..." rows={3} />
                </label>
              ) : null}
            </>
          )}
          <label><span>CPU</span><select name="cpu" defaultValue="2">{cpuOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Memory</span><select name="memory" defaultValue="2Gi">{memoryOptions.map((value) => <option key={value} value={value}>{formatMemory(value)}</option>)}</select></label>
          <label>
            <span>Session env</span>
            <textarea name="env" placeholder={"FOO=session-value\nAPI_BASE=http://localhost:3000"} rows={4} />
          </label>
          <Button disabled={busy} type="submit">
            <Plus aria-hidden="true" />
            Create session
          </Button>
        </form>
      </section>
    </ModalBackdrop>
  );
}
