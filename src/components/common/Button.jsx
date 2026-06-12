export function Button({
  children,
  className = "",
  icon = false,
  size = "",
  title = "",
  tooltip = "",
  type = "button",
  variant = "primary",
  ...props
}) {
  const buttonClassName = [
    "button",
    `button--${variant}`,
    icon ? "button--icon" : "",
    size ? `button--${size}` : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <button className={buttonClassName} title={title || tooltip || undefined} type={type} {...props}>
      {children}
    </button>
  );
}
