import {Download} from "lucide-react";
import {Button} from "../common/Button.jsx";

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
      <Button
        disabled={status.loading || status.installing || !onInstallPiPackage || !source.trim()}
        type="submit"
      >
        <Download aria-hidden="true" />
        {status.installing ? "Installing..." : "Install"}
      </Button>
    </form>
  );
}
