export function PackageRow({
  busy,
  installed = true,
  packageInfo,
  scopeLabel = "known",
  onInstallPiPackage,
  onRemovePiPackage,
  onUpdatePiPackage,
}) {
  const source = packageInfo.source || "unknown package";
  const meta = [
    packageInfo.type || "package",
    installed ? packageInfo.scope || "workspace" : scopeLabel,
    installed && packageInfo.filtered ? "filtered" : installed ? "unfiltered" : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={`package-row ${installed ? "" : "known-package-row"}`}>
      <div className="package-row-main">
        <strong>{source}</strong>
        <span className="subtle">{meta}</span>
        {installed ? (
          packageInfo.installedPath ? (
            <code className="package-path">{packageInfo.installedPath}</code>
          ) : (
            <span className="subtle">Configured; install path not present in the current runner.</span>
          )
        ) : (
          <span className="subtle">Not installed in this workspace.</span>
        )}
      </div>
      <div className="package-row-actions">
        {installed ? (
          <>
            <button className="secondary" disabled={busy || !onUpdatePiPackage} type="button" onClick={() => onUpdatePiPackage?.(source)}>
              {busy ? "Working..." : "Update"}
            </button>
            <button className="secondary" disabled={busy || !onRemovePiPackage} type="button" onClick={() => onRemovePiPackage?.(source)}>
              {busy ? "Working..." : "Remove"}
            </button>
          </>
        ) : (
          <button className="secondary" disabled={busy || !onInstallPiPackage} type="button" onClick={() => onInstallPiPackage?.(source)}>
            {busy ? "Installing..." : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}
