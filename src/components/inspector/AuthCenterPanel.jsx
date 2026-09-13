import {InspectorResourcePanel} from "./InspectorResourcePanel.jsx";

export function AuthCenterPanel({
  piAuth,
  state,
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
  return (
    <InspectorResourcePanel
      className="auth-center-panel"
      id="right-authentication"
      refresh={{className: "auth-center-refresh", onClick: onRefreshPiAuth}}
      state={state}
      status={status}
      title="Authentication Center"
      singularLabel="authentication provider"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      {status.environmentEntries?.length ? <p className="subtle">{status.environmentEntries.length} saved generic key(s); secrets are masked.</p> : null}
    </InspectorResourcePanel>
  );
}
