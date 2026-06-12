import {Plus, RefreshCw, Trash2} from "lucide-react";
import {piAuthProviderLabel} from "../../config/piAuthProviders.js";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {DrawerSection} from "../drawers/DrawerSection.jsx";

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function AuthProviderRow({provider, value, disabled, onDelete}) {
  const credential = value && typeof value === "object" ? value : {};
  const type = credential.type || "unknown";
  const keyValue = Object.prototype.hasOwnProperty.call(credential, "key") ? String(credential.key || "") : "";
  const fields = Object.keys(credential).filter((field) => field !== "key" && field !== "type").sort();

  const detail = (
    <>
      <span className="drawer-list-row__code">{provider}</span>
      <div className="drawer-list-row__meta">
        <span>{type}</span>
        {keyValue ? <span>{maskSecret(keyValue)}</span> : null}
        {fields.map((field) => <span key={field}>{field}</span>)}
      </div>
    </>
  );

  return (
    <DrawerListItem
      actions={[
        <DrawerListActionButton
          disabled={disabled || !onDelete}
          icon={<Trash2 aria-hidden="true" />}
          key="delete"
          label={`Delete ${piAuthProviderLabel(provider)}`}
          tone="danger"
          onClick={() => onDelete?.(provider)}
        />,
      ]}
      detail={detail}
      title={piAuthProviderLabel(provider)}
    />
  );
}

export function AuthCenterPanel({
  piAuth,
  state,
  onDeletePiAuthProvider,
  onOpenAuthModal,
  onRefreshPiAuth,
  onToggleDrawerSection,
}) {
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
        <Button
          aria-label="Refresh"
          className="auth-center-refresh"
          disabled={status.loading || status.saving || !onRefreshPiAuth}
          icon={true}
          key="refresh-auth"
          size="compact"
          tooltip="Refresh"
          variant="secondary"
          onClick={onRefreshPiAuth}
        >
          <RefreshCw aria-hidden="true" />
        </Button>,
        <Button
          aria-label="Add"
          className="auth-center-add"
          icon={true}
          key="add-auth"
          size="compact"
          tooltip="Add"
          variant="secondary"
          onClick={onOpenAuthModal}
        >
          <Plus aria-hidden="true" />
        </Button>,
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
        <DrawerList>
          {providerEntries.map(([provider, value]) => (
            <AuthProviderRow
              disabled={status.loading || status.saving}
              key={provider}
              provider={provider}
              value={value}
              onDelete={onDeletePiAuthProvider}
            />
          ))}
        </DrawerList>
      ) : (
        <p className="empty">No Pi auth providers saved yet.</p>
      )}
    </DrawerSection>
  );
}
