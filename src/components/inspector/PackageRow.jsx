import {Download, Trash2} from "lucide-react";
import {DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";

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

  const actions = installed ? [
    <DrawerListActionButton
      disabled={busy || !onUpdatePiPackage}
      icon={<Download aria-hidden="true" />}
      key="update"
      label={`Update ${source}`}
      onClick={() => onUpdatePiPackage?.(source)}
    />,
    <DrawerListActionButton
      disabled={busy || !onRemovePiPackage}
      icon={<Trash2 aria-hidden="true" />}
      key="remove"
      label={`Remove ${source}`}
      tone="danger"
      onClick={() => onRemovePiPackage?.(source)}
    />,
  ] : [
    <DrawerListActionButton
      disabled={busy || !onInstallPiPackage}
      icon={<Download aria-hidden="true" />}
      key="install"
      label={`Install ${source}`}
      onClick={() => onInstallPiPackage?.(source)}
    />,
  ];

  return (
    <DrawerListItem
      actions={actions}
      className={installed ? "" : "known-package-row"}
      detail={detail}
      meta={meta}
      title={source}
    />
  );
}
