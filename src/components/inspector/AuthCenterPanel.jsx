import {KeyRound, Plus, RefreshCw, Trash2} from "lucide-react";
import {piAuthProviderLabel} from "../../config/piAuthProviders.js";
import {Button} from "../common/Button.jsx";
import {DrawerList, DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {DrawerSection} from "../drawers/DrawerSection.jsx";

function normalizeEntries(status) {
  const entries = status.entries && typeof status.entries === "object" ? status.entries : {};
  const providers = status.providers && typeof status.providers === "object" ? status.providers : {};
  const normalized = Object.entries(entries).map(([id, entry]) => ({id, ...entry}));
  const entryProviderKeys = new Set(normalized.map((entry) => entry.providerKey));
  Object.entries(providers).forEach(([providerKey, credential]) => {
    if (!entryProviderKeys.has(providerKey)) {
      normalized.push({id: `legacy-${providerKey}`, providerKey, label: piAuthProviderLabel(providerKey), credential});
    }
  });
  return normalized.sort((left, right) => `${left.providerKey}:${left.label}`.localeCompare(`${right.providerKey}:${right.label}`));
}

function AuthProviderRow({entry, disabled, onDelete}) {
  const credential = entry.credential && typeof entry.credential === "object" ? entry.credential : {};
  const type = credential.type === "oauth" ? "OAuth credential" : credential.type === "api_key" ? "API key" : "Saved credential";
  const detail = (
    <div className="drawer-list-row__meta">
      <span>{type}</span>
    </div>
  );

  return (
    <DrawerListItem
      actions={[
        <DrawerListActionButton
          disabled={disabled || !onDelete}
          icon={<Trash2 aria-hidden="true" />}
          key="delete"
          label={`Delete ${entry.label || piAuthProviderLabel(entry.providerKey)}`}
          tone="danger"
          onClick={() => onDelete?.(entry.id)}
        />,
      ]}
      detail={detail}
      meta={piAuthProviderLabel(entry.providerKey)}
      title={entry.label || piAuthProviderLabel(entry.providerKey)}
    />
  );
}

function isPiBasedSession(session) {
  const terminalKind = String(session?.terminalKind || "").toLowerCase();
  const imageKey = String(session?.imageKey || "").toLowerCase();
  const image = String(session?.image || "").toLowerCase();
  return terminalKind === "pi" || imageKey.startsWith("pi-") || /session-runner:pi-/.test(image);
}

export function AuthCenterPanel({
  piAuth,
  selectedSession,
  state,
  onDeletePiAuthProvider,
  onOpenAuthModal,
  onOpenPiAuthManage,
  onRefreshPiAuth,
  onToggleDrawerSection,
}) {
  const status = piAuth || {
    loading: false,
    saving: false,
    error: "",
    message: "",
    providers: {},
    entries: {},
  };
  const providerEntries = normalizeEntries(status);
  const showManagePiAuth = isPiBasedSession(selectedSession);

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
      {showManagePiAuth ? (
        <Button
          className="auth-center-manage"
          disabled={status.loading || status.saving || !onOpenPiAuthManage}
          variant="secondary"
          onClick={onOpenPiAuthManage}
        >
          <KeyRound aria-hidden="true" />
          Manage Pi Auth
        </Button>
      ) : null}
      {status.error ? <p className="empty">{status.error}</p> : null}
      {status.message ? <p className="subtle">{status.message}</p> : null}
      {providerEntries.length ? (
        <DrawerList>
          {providerEntries.map((entry) => (
            <AuthProviderRow
              disabled={status.loading || status.saving}
              entry={entry}
              key={entry.id}
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
