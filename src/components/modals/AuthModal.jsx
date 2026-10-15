import {Save, X} from "lucide-react";
import {isCustomPiProvider, piAuthProviders} from "../../config/piAuthProviders.js";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const GITHUB_CLI_PROVIDER = "github-cli";

export function AuthModal({
  piAuth = {},
  onClose,
  onSave,
  onStartOpenAiCodexDeviceLogin,
  onUpdate,
}) {
  const selectedProvider = piAuth.selectedProvider || piAuthProviders[0]?.key || "";
  const apiKey = piAuth.apiKey || "";
  const entryLabel = piAuth.entryLabel || "";
  const editing = Boolean(piAuth.editEntryId);
  const isOpenAiCodex = selectedProvider === OPENAI_CODEX_PROVIDER;
  const isGitHubCli = selectedProvider === GITHUB_CLI_PROVIDER;
  const isCustom = selectedProvider === "openai-compatible" || isCustomPiProvider(selectedProvider);
  const device = piAuth.openAiCodexDevice;

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="auth-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="auth-modal-title">{editing ? "Edit Authentication Provider" : "Add Authentication Provider"}</h2>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <form
          className="modal-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (isOpenAiCodex) {
              onStartOpenAiCodexDeviceLogin?.();
              return;
            }
            if (await onSave(isCustom && !editing ? "openai-compatible" : selectedProvider, apiKey, entryLabel)) onClose();
          }}
        >
          <select
            className="auth-provider-select"
            disabled={editing}
            name="provider"
            value={isCustom ? "openai-compatible" : selectedProvider}
            onChange={(event) => onUpdate?.({
              selectedProvider: event.target.value,
              apiKey: "",
              customProviderId: "",
              baseUrl: "",
              entryLabel: "",
              openAiCodexDevice: null,
            })}
          >
            {piAuthProviders.map((provider) => <option key={provider.key} value={provider.key}>{provider.label}</option>)}
          </select>
          <input
            className="auth-key-input"
            name="entryLabel"
            placeholder="Entry label (optional)"
            type="text"
            value={entryLabel}
            onChange={(event) => onUpdate?.({entryLabel: event.target.value})}
          />
          {isCustom ? (
            <>
              <label>Provider ID
                <input name="customProviderId" placeholder="custom-lab" required pattern="custom-[a-z0-9][a-z0-9-]{0,62}" disabled={editing}
                  value={piAuth.customProviderId || ""} onChange={(event) => onUpdate?.({customProviderId: event.target.value})} />
              </label>
              <label>Server base URL
                <input name="baseUrl" placeholder="https://models.example.org/v1" type="url" required
                  value={piAuth.baseUrl || ""} onChange={(event) => onUpdate?.({baseUrl: event.target.value})} />
              </label>
              <p className="subtle">Use this provider ID in Agent Settings → Models. Select the credential for your session, then restart the workspace. Configure model IDs and capabilities in the Agent. The server must be reachable from the cloud runner. For a server without authentication, enter a placeholder key.</p>
            </>
          ) : null}
          {isOpenAiCodex ? (
            <OpenAiCodexLoginFields
              device={device}
              saving={piAuth.saving}
              onStartDeviceLogin={onStartOpenAiCodexDeviceLogin}
            />
          ) : (
            <input
              className="auth-key-input"
              name="apiKey"
              placeholder={isGitHubCli ? "GitHub token" : "API Key"}
              type="password"
              value={apiKey}
              onChange={(event) => onUpdate?.({apiKey: event.target.value})}
            />
          )}
          {piAuth.error ? <p className="empty">{piAuth.error}</p> : null}
          {piAuth.message ? <p className="subtle">{piAuth.message}</p> : null}
          <div className="modal-actions">
            <Button disabled={piAuth.saving} type="submit">
              {!isOpenAiCodex ? <Save aria-hidden="true" /> : null}
              {isOpenAiCodex ? "Start Device Login" : editing ? "Save changes" : "Save"}
            </Button>
          </div>
        </form>
      </section>
    </ModalBackdrop>
  );
}

function OpenAiCodexLoginFields({device, saving}) {
  return (
    <div className="auth-oauth-flow">
      <p className="subtle">
Sign in with your ChatGPT Plus/Pro account using OpenAI's Codex device-code flow.
      </p>
      {device?.userCode ? (
        <div className="auth-device-code">
          <span className="auth-device-code-label">OpenAI code</span>
          <strong>{device.userCode}</strong>
          <a href={device.verificationUri} rel="noreferrer" target="_blank">Open OpenAI login</a>
          <span className="subtle">Status: {device.status || "pending"}</span>
        </div>
      ) : (
        <p className="subtle">
Click start, enter the displayed code at OpenAI, and this app will save the OAuth credential to Pi auth.json.
        </p>
      )}
      {saving ? <p className="subtle">Starting login...</p> : null}
    </div>
  );
}
