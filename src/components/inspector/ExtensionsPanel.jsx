import {DrawerSection} from "../drawers/DrawerSection.jsx";
import {PackageInstallForm} from "./PackageInstallForm.jsx";
import {PackageRow} from "./PackageRow.jsx";

function PackageList({knownPackages, packages, status, userPackages, onInstallPiPackage, onRemovePiPackage, onUpdatePiPackage}) {
  return (
    <div className="package-list">
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
    </div>
  );
}

function ExtensionsBody(props) {
  const {knownPackages, packages, selectedSession, status, userPackages} = props;

  if (!selectedSession) {
    return <p className="empty">Start or select an active session to inspect workspace-local Pi extensions.</p>;
  }
  if (status.loading) {
    return <p className="empty">Loading workspace extensions...</p>;
  }
  if (status.error) {
    return <p className="empty">{status.error}</p>;
  }
  if (!packages.length && !knownPackages.length && !userPackages.length) {
    return <p className="empty">No workspace-local Pi packages are configured. Packages installed with `pi install -l ...` will appear here after refresh.</p>;
  }
  return <PackageList {...props} />;
}

export function ExtensionsPanel({
  piPackages,
  selectedSession,
  state,
  onInstallPiPackage,
  onRefreshPiPackages,
  onRemovePiPackage,
  onToggleDrawerSection,
  onUpdatePiInstallSource,
  onUpdatePiPackage,
}) {
  const status = piPackages || {loading: false, error: "", unavailable: false, data: null};
  const packages = status.data && Array.isArray(status.data.packages) ? status.data.packages : [];
  const knownPackages = status.data && Array.isArray(status.data.knownPackages) ? status.data.knownPackages : [];
  const userPackages = status.data && Array.isArray(status.data.userPackages) ? status.data.userPackages : [];

  return (
    <DrawerSection
      actions={[
        <div className="git-status-actions" key="package-actions">
          <button
            className="secondary"
            disabled={status.loading || status.installing || !onUpdatePiPackage || !packages.length}
            type="button"
            onClick={() => onUpdatePiPackage?.()}
          >
            {status.installing ? "Working..." : "Update all"}
          </button>
          <button
            className="secondary"
            disabled={status.loading || status.installing || !onRefreshPiPackages}
            type="button"
            onClick={onRefreshPiPackages}
          >
            {status.loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>,
      ]}
      className="extensions-panel"
      id="right-extensions"
      state={state}
      title="Extensions"
      onToggleDrawerSection={onToggleDrawerSection}
    >
      <p className="subtle">Workspace-local Pi packages only. This web view reflects Pi TUI/CLI changes after refresh.</p>
      {selectedSession ? (
        <PackageInstallForm
          status={status}
          onInstallPiPackage={onInstallPiPackage}
          onUpdatePiInstallSource={onUpdatePiInstallSource}
        />
      ) : null}
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
    </DrawerSection>
  );
}
