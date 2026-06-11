import {piAuthProviderLabel} from "../../config/piAuthProviders.js";
import {DrawerSection} from "../drawers/DrawerSection.jsx";

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function AuthProviderRow({provider, value}) {
  const credential = value && typeof value === "object" ? value : {};
  const type = credential.type || "unknown";
  const keyValue = Object.prototype.hasOwnProperty.call(credential, "key") ? String(credential.key || "") : "";
  const fields = Object.keys(credential).filter((field) => field !== "key" && field !== "type").sort();

  return (
    <div className="auth-provider-row">
      <div>
        <strong>{piAuthProviderLabel(provider)}</strong>
        <span className="auth-provider-key">{provider}</span>
      </div>
      <div className="auth-provider-meta">
        <span>{type}</span>
        {keyValue ? <span>{maskSecret(keyValue)}</span> : null}
        {fields.map((field) => <span key={field}>{field}</span>)}
      </div>
    </div>
  );
}

export function AuthCenterPanel({piAuth, state, onOpenAuthModal, onRefreshPiAuth, onToggleDrawerSection}) {
  const status = piAuth || {
    loading: false,
    saving: false,
    error: "",
    message: "",
    providers: {},
  };
  const providers = status.providers && typeof status.providers === "object" ? status.providers : {};
  const providerEntries = Object.entries(providers).sort(([left], [right]) => left.localeCompare(right));

  return (
    <DrawerSection
      actions={[
        <button
          aria-label="Refresh"
          className="secondary auth-center-refresh icon-button"
          disabled={status.loading || status.saving || !onRefreshPiAuth}
          key="refresh-auth"
          type="button"
          onClick={onRefreshPiAuth}
        >
          ↻
        </button>,
        <button
          aria-label="Add"
          className="secondary auth-center-add icon-button"
          key="add-auth"
          type="button"
          onClick={onOpenAuthModal}
        >
          +
        </button>,
      ]}
      className="auth-center-panel"
      id="right-authentication"
      state={state}
      title="Authentication Center"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <p className="subtle">
        User-scoped Pi auth providers. API keys saved here are materialized into ~/.pi/agent/auth.json for new sessions; CLI /login changes sync back after runner refresh.
      </p>
      {status.error ? <p className="empty">{status.error}</p> : null}
      {status.message ? <p className="subtle">{status.message}</p> : null}
      {providerEntries.length ? (
        <div className="auth-provider-list">
          {providerEntries.map(([provider, value]) => (
            <AuthProviderRow key={provider} provider={provider} value={value} />
          ))}
        </div>
      ) : (
        <p className="empty">No Pi auth providers saved yet.</p>
      )}
    </DrawerSection>
  );
}
