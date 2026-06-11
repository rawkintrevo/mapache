export function PackageInstallForm({status, onInstallPiPackage, onUpdatePiInstallSource}) {
  const source = status.installSource || "";

  return (
    <form
      className="package-install-form"
      onSubmit={(event) => {
        event.preventDefault();
        onInstallPiPackage?.(source);
      }}
    >
      <input
        autoComplete="off"
        disabled={status.loading || status.installing}
        placeholder="npm:@scope/package or git:https://..."
        type="text"
        value={source}
        onChange={(event) => onUpdatePiInstallSource?.(event.target.value)}
      />
      <button
        disabled={status.loading || status.installing || !onInstallPiPackage || !source.trim()}
        type="submit"
      >
        {status.installing ? "Installing..." : "Install"}
      </button>
    </form>
  );
}
