import {Download} from "lucide-react";
import {DrawerListActionButton} from "../drawers/DrawerList.jsx";
import {InspectorResourceRow} from "./InspectorResourcePanel.jsx";

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

  const detail = installed ? (
    packageInfo.installedPath ? (
      <code className="drawer-list-row__code">{packageInfo.installedPath}</code>
    ) : (
      <span className="subtle">Configured; install path not present in the current runner.</span>
    )
  ) : (
    <span className="subtle">Not installed in this workspace.</span>
  );

  return (
    <InspectorResourceRow
      busy={busy}
      className={installed ? "" : "known-package-row"}
      detail={detail}
      meta={meta}
      resource={packageInfo}
      title={source}
      edit={installed ? {
        disabled: !onUpdatePiPackage,
        icon: <Download aria-hidden="true" />,
        label: `Update ${source}`,
        onClick: (item) => onUpdatePiPackage?.(item.source),
      } : null}
      extraActions={!installed ? [
        <DrawerListActionButton
          disabled={busy || !onInstallPiPackage}
          icon={<Download aria-hidden="true" />}
          key="install"
          label={`Install ${source}`}
          onClick={() => onInstallPiPackage?.(source)}
        />,
      ] : []}
      onDelete={installed ? {
        disabled: !onRemovePiPackage,
        label: `Remove ${source}`,
        onClick: (item) => onRemovePiPackage?.(item.source),
      } : null}
    />
  );
}
