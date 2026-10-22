import {Power, RotateCcw} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {Button} from "../common/Button.jsx";

export function TopbarPowerMenu({
  actionDisabled = false,
  onRestart,
  onToggle,
  restartDisabled = false,
  workspaceOn = false,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const stateLabel = workspaceOn ? "running" : "stopped";

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector("[role='menuitem']:not(:disabled)")?.focus();

    function closeOnOutsideClick(event) {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...menuRef.current.querySelectorAll("[role='menuitem']:not(:disabled)")];
      if (!items.length) return;
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
        event.key === "ArrowDown" ? (currentIndex + 1) % items.length :
          (currentIndex <= 0 ? items.length - 1 : currentIndex - 1);
      items[nextIndex]?.focus();
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function runAction(action) {
    action?.();
    setOpen(false);
  }

  return (
    <div className="topbar-power-menu" ref={menuRef}>
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Workspace power controls: ${stateLabel}`}
        className={`topbar-power-trigger topbar-power-trigger--${stateLabel}`}
        icon
        title={`Workspace ${stateLabel}. Open power controls`}
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
      >
        <Power aria-hidden="true" />
      </Button>
      {open ? (
        <div aria-label="Workspace power controls" className="topbar-power-popover" role="menu">
          <button disabled={actionDisabled} role="menuitem" type="button" onClick={() => runAction(onToggle)}>
            <Power aria-hidden="true" />
            {workspaceOn ? "Stop workspace" : "Start workspace"}
          </button>
          <button disabled={restartDisabled} role="menuitem" type="button" onClick={() => runAction(onRestart)}>
            <RotateCcw aria-hidden="true" />
            Restart workspace
          </button>
        </div>
      ) : null}
    </div>
  );
}
