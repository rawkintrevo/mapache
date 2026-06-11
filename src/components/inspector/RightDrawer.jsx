import {DrawerSection} from "../drawers/DrawerSection.jsx";
import {AuthCenterPanel} from "./AuthCenterPanel.jsx";
import {ExtensionsPanel} from "./ExtensionsPanel.jsx";

export function RightDrawer({
  selectedSession,
  state,
  onInstallPiPackage,
  onDeletePiAuthProvider,
  onOpenAuthModal,
  onRefreshPiAuth,
  onRefreshPiPackages,
  onRemovePiPackage,
  onToggleDrawerSection,
  onToggleRightDrawer,
  onUpdatePiInstallSource,
  onUpdatePiPackage,
}) {
  const toggleButton = (
    <button
      aria-expanded={String(!state.rightDrawerCollapsed)}
      aria-label={state.rightDrawerCollapsed ? "Expand inspector" : "Collapse inspector"}
      className="drawer-toggle secondary"
      title={state.rightDrawerCollapsed ? "Expand inspector" : "Collapse inspector"}
      type="button"
      onClick={onToggleRightDrawer}
    >
      <span aria-hidden="true" className="icon">{state.rightDrawerCollapsed ? "☰" : "›"}</span>
    </button>
  );

  if (state.rightDrawerCollapsed) {
    return <aside className="drawer inspector collapsed">{toggleButton}</aside>;
  }

  return (
    <aside className="drawer inspector">
      <div className="drawer-header">
        <h2>Inspector</h2>
        {toggleButton}
      </div>
      <AuthCenterPanel
        piAuth={state.piAuth}
        state={state}
        onDeletePiAuthProvider={onDeletePiAuthProvider}
        onOpenAuthModal={onOpenAuthModal}
        onRefreshPiAuth={onRefreshPiAuth}
        onToggleDrawerSection={onToggleDrawerSection}
      />
      <DrawerSection id="right-skills" state={state} title="Skills" onToggleDrawerSection={onToggleDrawerSection}>
        <p className="empty">tbd</p>
      </DrawerSection>
      <ExtensionsPanel
        piPackages={state.piPackages}
        selectedSession={selectedSession}
        state={state}
        onInstallPiPackage={onInstallPiPackage}
        onRefreshPiPackages={onRefreshPiPackages}
        onRemovePiPackage={onRemovePiPackage}
        onToggleDrawerSection={onToggleDrawerSection}
        onUpdatePiInstallSource={onUpdatePiInstallSource}
        onUpdatePiPackage={onUpdatePiPackage}
      />
    </aside>
  );
}
