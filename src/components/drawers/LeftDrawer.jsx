import "./Drawers.css";
import {Bot, PanelLeftClose, PanelLeftOpen, ScrollText} from "lucide-react";
import {UserMenu} from "./UserMenu.jsx";
import {Button} from "../common/Button.jsx";
import {isMarkedRuntimeSession} from "../sessions/sessionPresentation.js";

export function LeftDrawer({
  activeCanvas,
  state,
  selectedSession,
  onRefresh,
  onSelectCanvas,
  onShowLogs,
  onShowAdmin,
  onShowProfile,
  onSignOut,
  onToggleDrawer,
}) {
  const showSurfaceToolbar = state.activePage === "workspace" && isMarkedRuntimeSession(selectedSession);

  const toggleButton = (
    <Button
      aria-expanded={String(!state.drawerCollapsed)}
      aria-label={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      className="drawer-toggle"
      icon={true}
      title={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      tooltip={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      variant="secondary"
      onClick={onToggleDrawer}
    >
      {state.drawerCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
    </Button>
  );

  const surfaceToolbar = showSurfaceToolbar ? (
    <section aria-label="Workspace tools" className="surface-toolbar">
      <div aria-label="Workspace tools" className="surface-toolbar__actions" role="group">
        <Button
          aria-label="Agent"
          aria-pressed={activeCanvas === "agent"}
          className="surface-toolbar__button"
          disabled={!selectedSession?.serviceUrl}
          icon={state.drawerCollapsed}
          title="Agent"
          variant={activeCanvas === "agent" ? "primary" : "secondary"}
          onClick={() => onSelectCanvas?.("agent")}
        >
          <Bot aria-hidden="true" />
          <span>Agent</span>
        </Button>
        <Button
          aria-label="Logs"
          className="surface-toolbar__button"
          icon={state.drawerCollapsed}
          title="Logs"
          variant="secondary"
          onClick={onShowLogs}
        >
          <ScrollText aria-hidden="true" />
          <span>Logs</span>
        </Button>
      </div>
    </section>
  ) : null;

  if (state.drawerCollapsed) {
    return (
      <aside className="drawer navigation-drawer collapsed">
        {toggleButton}
        {surfaceToolbar}
      </aside>
    );
  }

  return (
    <aside className="drawer navigation-drawer">
      <div className="drawer-content">
        <div className="drawer-header">
          <h2>Navigation</h2>
          {toggleButton}
        </div>
        {surfaceToolbar}
      </div>
      <UserMenu
        state={state}
        onRefresh={onRefresh}
        onShowAdmin={onShowAdmin}
        onShowProfile={onShowProfile}
        onSignOut={onSignOut}
      />
    </aside>
  );
}
