import "./Drawers.css";
import {Bot, Globe2, PanelLeftClose, PanelLeftOpen} from "lucide-react";
import {UserMenu} from "./UserMenu.jsx";
import {Button} from "../common/Button.jsx";
import {isMarkedRuntimeSession} from "../sessions/sessionPresentation.js";

export function LeftDrawer({
  activeCanvas,
  state,
  selectedSession,
  onRefresh,
  onSelectCanvas,
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
    <section aria-label="Logs" className="surface-toolbar">
      <h2 className="surface-toolbar__heading">Logs</h2>
      <div aria-label="Workspace surfaces" className="surface-toolbar__actions" role="tablist">
        <Button
          aria-label="Agent"
          aria-selected={activeCanvas === "agent"}
          className="surface-toolbar__button"
          disabled={!selectedSession?.serviceUrl}
          icon={state.drawerCollapsed}
          role="tab"
          title="Agent"
          variant={activeCanvas === "agent" ? "primary" : "secondary"}
          onClick={() => onSelectCanvas?.("agent")}
        >
          <Bot aria-hidden="true" />
          <span>Agent</span>
        </Button>
        {selectedSession?.capabilities?.chrome ? (
          <Button
            aria-label="Persistent Chrome"
            aria-selected={activeCanvas === "chrome"}
            className="surface-toolbar__button"
            disabled={!selectedSession?.serviceUrl}
            icon={state.drawerCollapsed}
            role="tab"
            title="Persistent Chrome"
            variant={activeCanvas === "chrome" ? "primary" : "secondary"}
            onClick={() => onSelectCanvas?.("chrome")}
          >
            <Globe2 aria-hidden="true" />
            <span>Persistent Chrome</span>
          </Button>
        ) : null}
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
