import "./Drawers.css";
import {PanelLeftClose, PanelLeftOpen, Plus} from "lucide-react";
import {DrawerSessionList} from "./DrawerSessionList.jsx";
import {DrawerSection} from "./DrawerSection.jsx";
import {UserMenu} from "./UserMenu.jsx";
import {Button} from "../common/Button.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

export function LeftDrawer({
  state,
  onDeleteSession,
  onEditSession,
  onOpenSessionModal,
  onRefresh,
  onRestartSession,
  onRetryProvisioningSession,
  onSelectSession,
  onShowAdmin,
  onShowProfile,
  onSignOut,
  onStopSession,
  onToggleDrawer,
  onToggleDrawerSection,
}) {
  const busy = hasPendingOperations(state.pendingOperations);

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

  if (state.drawerCollapsed) {
    return <aside className="drawer navigation-drawer collapsed">{toggleButton}</aside>;
  }

  return (
    <aside className="drawer navigation-drawer">
      <div className="drawer-content">
        <div className="drawer-header">
          <h2>Navigation</h2>
          {toggleButton}
        </div>
        <DrawerSection
          actions={[
            <Button
              aria-label="Create session"
              disabled={busy || !state.selectedWorkspaceId}
              icon={true}
              key="create-session"
              size="compact"
              title="Create session"
              tooltip="Create session"
              variant="secondary"
              onClick={onOpenSessionModal}
            >
              <Plus aria-hidden="true" />
            </Button>,
          ]}
          id="left-sessions"
          state={state}
          title="Sessions"
          onToggleDrawerSection={onToggleDrawerSection}
        >
          <DrawerSessionList
            state={state}
            onDeleteSession={onDeleteSession}
            onEditSession={onEditSession}
            onRestartSession={onRestartSession}
            onRetryProvisioningSession={onRetryProvisioningSession}
            onSelectSession={onSelectSession}
            onStopSession={onStopSession}
          />
        </DrawerSection>
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
