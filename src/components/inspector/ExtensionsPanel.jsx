import {useState} from "react";
import {Download} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerList} from "../drawers/DrawerList.jsx";
import {sessionHarness, sessionSupportsPackages} from "../../utils/sessionHarnesses.js";
import {PackageInstallForm} from "./PackageInstallForm.jsx";
import {PackageRow} from "./PackageRow.jsx";
import {InspectorEditorModal} from "./InspectorEditorModal.jsx";
import {InspectorResourcePanel} from "./InspectorResourcePanel.jsx";

function PackageList({knownPackages, packages, status, userPackages, onInstallPiPackage, onRemovePiPackage, onUpdatePiPackage}) {
  return (
    <DrawerList className="package-list">
      {packages.map((packageInfo) => (
        <PackageRow
          busy={status.installing}
          installed={true}
          key={`installed-${packageInfo.source}`}
          packageInfo={packageInfo}
          onRemovePiPackage={onRemovePiPackage}
          onUpdatePiPackage={onUpdatePiPackage}
        />
      ))}
      {userPackages.length ? (
        <div className="package-subsection">
          <h4>User-scoped packages</h4>
          <p className="subtle">Installed for Pi in this session user scope, not automatically installed in this workspace.</p>
          {userPackages.map((packageInfo) => (
            <PackageRow
              busy={status.installing}
              installed={false}
              key={`user-${packageInfo.source}`}
              packageInfo={packageInfo}
              scopeLabel="user-scoped"
              onInstallPiPackage={onInstallPiPackage}
            />
          ))}
        </div>
      ) : null}
      {knownPackages.length ? (
        <div className="package-subsection">
          <h4>Known packages</h4>
          <p className="subtle">Packages observed in your other workspaces. Use Install to add one to this workspace.</p>
          {knownPackages.map((packageInfo) => (
            <PackageRow
              busy={status.installing}
              installed={false}
              key={`known-${packageInfo.source}`}
              packageInfo={packageInfo}
              onInstallPiPackage={onInstallPiPackage}
            />
          ))}
        </div>
      ) : null}
    </DrawerList>
  );
}

function ExtensionsBody(props) {
  const {knownPackages, packages, selectedSession, status, userPackages} = props;
  const harness = sessionHarness(selectedSession);

  if (!selectedSession) {
    return <p className="empty">Start or select an active session to inspect workspace-local extensions.</p>;
  }
  if (!sessionSupportsPackages(selectedSession)) {
    return <p className="empty">{harness?.label || "This"} sessions do not support workspace-local extensions.</p>;
  }
  if (status.loading) {
    return <p className="empty">Loading workspace extensions...</p>;
  }
  if (!packages.length && !knownPackages.length && !userPackages.length) {
    return <p className="empty">No workspace-local extensions are configured for this harness.</p>;
  }
  return <PackageList {...props} />;
}

export function ExtensionsPanel({
  piPackages,
  selectedSession,
  state,
  onInstallPiPackage,
  onNewPiPackage,
  onRefreshPiPackages,
  onRemovePiPackage,
  onToggleDrawerSection,
  onUpdatePiInstallSource,
  onUpdatePiPackage,
}) {
  const status = piPackages || {loading: false, error: "", unavailable: false, data: null};
  const harness = sessionHarness(selectedSession);
  const packages = status.data && Array.isArray(status.data.packages) ? status.data.packages : [];
  const knownPackages = status.data && Array.isArray(status.data.knownPackages) ? status.data.knownPackages : [];
  const userPackages = status.data && Array.isArray(status.data.userPackages) ? status.data.userPackages : [];
  const [editorOpen, setEditorOpen] = useState(false);
  const openNew = () => {
    onNewPiPackage?.();
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    onNewPiPackage?.();
  };
  const submitEditor = async () => {
    const installed = await onInstallPiPackage?.(status.installSource || "");
    if (installed) setEditorOpen(false);
  };

  return (
    <InspectorResourcePanel
      className="extensions-panel"
      create={{
        disabled: !sessionSupportsPackages(selectedSession) || !onNewPiPackage,
        label: "New extension",
        onClick: openNew,
      }}
      description={sessionSupportsPackages(selectedSession) ?
        `Workspace-local ${harness?.label || "harness"} packages. This view reflects terminal-side changes after refresh.` :
        "Workspace-local package management is unavailable for this harness."}
      extraActions={[
        <Button
          aria-label="Update all"
          disabled={status.loading || status.installing || !onUpdatePiPackage || !packages.length}
          icon={true}
          key="update-all"
          size="compact"
          title="Update all"
          tooltip="Update all"
          variant="secondary"
          onClick={() => onUpdatePiPackage?.()}
        >
          <Download aria-hidden="true" />
        </Button>,
      ]}
      id="right-extensions"
      refresh={{onClick: onRefreshPiPackages}}
      state={state}
      status={status}
      title="Extensions"
      singularLabel="extension"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      {status.installMessage ? <p className="subtle">{status.installMessage}</p> : null}
      <ExtensionsBody
        knownPackages={knownPackages}
        packages={packages}
        selectedSession={selectedSession}
        status={status}
        userPackages={userPackages}
        onInstallPiPackage={onInstallPiPackage}
        onRemovePiPackage={onRemovePiPackage}
        onUpdatePiPackage={onUpdatePiPackage}
      />
      {editorOpen ? (
        <InspectorEditorModal
          description="Install a package into the selected workspace and harness."
          error={status.error}
          message={status.installMessage}
          onClose={closeEditor}
          onSubmit={submitEditor}
          saving={status.installing}
          submitLabel="Install"
          title="New extension"
        >
          <PackageInstallForm
            embedded={true}
            status={status}
            onInstallPiPackage={onInstallPiPackage}
            onUpdatePiInstallSource={onUpdatePiInstallSource}
          />
        </InspectorEditorModal>
      ) : null}
    </InspectorResourcePanel>
  );
}
