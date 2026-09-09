import {KeyRound} from "lucide-react";
import {sessionAuthHarness, sessionSupportsAuth} from "../../utils/sessionHarnesses.js";
import {Button} from "../common/Button.jsx";
import {InspectorResourcePanel} from "./InspectorResourcePanel.jsx";

export function AuthCenterPanel({
  piAuth,
  selectedSession,
  state,
  onOpenPiAuthManage,
  onOpenGenericEnvironment,
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
  const authHarness = sessionAuthHarness(selectedSession);
  const showManagePiAuth = sessionSupportsAuth(selectedSession);

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
      {showManagePiAuth ? (
        <Button
          className="auth-center-manage"
          disabled={status.loading || status.saving || !onOpenPiAuthManage}
          variant="secondary"
          onClick={onOpenPiAuthManage}
        >
          <KeyRound aria-hidden="true" />
          {authHarness?.manageTitle || "Manage Auth"}
        </Button>
      ) : null}
      <Button className="auth-center-manage" variant="secondary" onClick={onOpenGenericEnvironment}>Manage generic environment keys</Button>
      {status.environmentEntries?.length ? <p className="subtle">{status.environmentEntries.length} saved generic key(s); secrets are masked.</p> : null}
    </InspectorResourcePanel>
  );
}
