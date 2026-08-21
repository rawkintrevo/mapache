import {Edit3, Plus, RefreshCw, Trash2} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {DrawerListActionButton, DrawerListItem} from "../drawers/DrawerList.jsx";
import {DrawerSection} from "../drawers/DrawerSection.jsx";

/**
 * The inspector uses this shared resource contract for panels that manage a
 * list of workspace or user resources. Domain panels own data fetching and
 * forms, while this component owns the repeated section chrome and action
 * treatment.
 */
export function InspectorResourcePanel({
  children,
  className = "",
  create = null,
  description = null,
  extraActions = [],
  id,
  refresh = null,
  state,
  status = {},
  title,
  singularLabel = "item",
  onToggleDrawerSection,
}) {
  const busy = resourceBusy(status);
  const createLabel = create?.label || `New ${singularLabel}`;
  const actions = [];

  if (refresh) {
    actions.push(
      <Button
        aria-label={refresh.label || "Refresh"}
        className={refresh.className || ""}
        disabled={busy || refresh.disabled || !refresh.onClick}
        icon={true}
        key="refresh"
        size="compact"
        title={refresh.label || "Refresh"}
        tooltip={refresh.label || "Refresh"}
        variant="secondary"
        onClick={refresh.onClick}
      >
        <RefreshCw aria-hidden="true" />
      </Button>,
    );
  }

  actions.push(...extraActions);

  return (
    <DrawerSection
      actions={actions}
      className={className}
      id={id}
      state={state}
      title={title}
      onToggleDrawerSection={onToggleDrawerSection}
    >
      {create ? (
        <Button
          className={["inspector-resource-create", create.className || ""].filter(Boolean).join(" ")}
          disabled={busy || create.disabled || !create.onClick}
          variant="secondary"
          onClick={create.onClick}
        >
          <Plus aria-hidden="true" />
          {createLabel}
        </Button>
      ) : null}
      {description ? <p className="subtle inspector-resource-description">{description}</p> : null}
      {status.error ? <p className="empty inspector-resource-error">{status.error}</p> : null}
      {status.message ? <p className="subtle inspector-resource-message">{status.message}</p> : null}
      {children}
    </DrawerSection>
  );
}

export function InspectorResourceRow({
  busy = false,
  children,
  className = "",
  detail = null,
  edit = null,
  extraActions = [],
  meta = "",
  resource,
  title,
  onDelete = null,
}) {
  const resourceTitle = title || resource?.name || "Unnamed item";
  const actions = [...extraActions];

  if (edit) {
    actions.push(
      <DrawerListActionButton
        disabled={busy || edit.disabled || !edit.onClick}
        icon={edit.icon || <Edit3 aria-hidden="true" />}
        key="edit"
        label={edit.label || `Edit ${resourceTitle}`}
        onClick={() => edit.onClick?.(resource)}
      />,
    );
  }

  if (onDelete) {
    actions.push(
      <DrawerListActionButton
        disabled={busy || onDelete.disabled || !onDelete.onClick}
        icon={<Trash2 aria-hidden="true" />}
        key="delete"
        label={onDelete.label || `Delete ${resourceTitle}`}
        tone="danger"
        onClick={() => onDelete.onClick?.(resource)}
      />,
    );
  }

  return (
    <DrawerListItem
      actions={actions}
      className={className}
      detail={detail}
      meta={meta}
      title={resourceTitle}
    >
      {children}
    </DrawerListItem>
  );
}

export function resourceBusy(status = {}) {
  return Boolean(
    status.loading ||
    status.saving ||
    status.installing ||
    status.connecting ||
    status.deleting ||
    status.mutating,
  );
}

export function InspectorResourceEmpty({children}) {
  return <p className="empty inspector-resource-empty">{children}</p>;
}
