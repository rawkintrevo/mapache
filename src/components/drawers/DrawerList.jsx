import {Button} from "../common/Button.jsx";

export function DrawerList({children, className = ""}) {
  return <div className={["drawer-list", className].filter(Boolean).join(" ")}>{children}</div>;
}

export function DrawerListItem({
  actions = [],
  active = false,
  badge = "",
  children,
  className = "",
  detail = null,
  meta = "",
  title,
  onSelect,
}) {
  const mainClassName = "drawer-list-row__main";
  const content = (
    <>
      <span className="drawer-list-row__title">
        <span>{title}</span>
        {badge ? <span className="pill">{badge}</span> : null}
      </span>
      {meta ? <span className="subtle">{meta}</span> : null}
      {detail}
      {children}
    </>
  );

  return (
    <div className={["drawer-list-row", active ? "active" : "", className].filter(Boolean).join(" ")}>
      {onSelect ? (
        <button className={mainClassName} type="button" onClick={onSelect}>
          {content}
        </button>
      ) : (
        <div className={mainClassName}>{content}</div>
      )}
      {actions.length ? <div className="drawer-list-row__actions">{actions}</div> : null}
    </div>
  );
}

export function DrawerListActionButton({
  children,
  className = "",
  icon,
  label,
  showLabel = false,
  tone = "neutral",
  ...props
}) {
  const iconOnly = !showLabel;

  return (
    <Button
      aria-label={label}
      className={["drawer-list-action", tone === "danger" ? "drawer-list-action--danger" : "", className].filter(Boolean).join(" ")}
      icon={iconOnly}
      size={iconOnly ? "compact" : ""}
      tooltip={iconOnly ? label : ""}
      variant="secondary"
      {...props}
    >
      {icon}
      {showLabel && children ? <span>{children}</span> : null}
    </Button>
  );
}
