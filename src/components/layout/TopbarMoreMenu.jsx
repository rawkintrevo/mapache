import {useEffect, useRef, useState} from "react";
import {Blocks, BookOpen, Bot, KeyRound, MoreHorizontal, Pencil, PlugZap, Plus, RefreshCw, ScrollText, Trash2, Variable} from "lucide-react";
import {Button} from "../common/Button.jsx";

export function TopbarMoreMenu({
  disabled = false,
  managePiAuthLabel = "Manage Auth",
  onDeleteWorkspace,
  onOpenGenericEnvironment,
  onOpenGoogleWorkspace,
  onOpenMcpServers,
  onOpenPiAuthManage,
  onOpenWorkspaceEditModal,
  onOpenWorkspaceModal,
  onRefresh,
  onSelectCanvas,
  onShowLogs,
  selectedWorkspace,
  showWorkspaceTools = false,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const firstItemRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    firstItemRef.current?.focus();
    function closeOnOutsideClick(event) {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);
  const workspaceLabel = selectedWorkspace?.name || "selected workspace";

  return (
    <div className="topbar-more-menu" ref={menuRef}>
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More workspace actions"
        className="topbar-more-trigger"
        disabled={disabled}
        icon
        title="More workspace actions"
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
      >
        <MoreHorizontal aria-hidden="true" />
      </Button>
      {open ? (
        <div aria-label="More workspace actions" className="topbar-more-popover" role="menu">
          {showWorkspaceTools ? <>
            <MenuItem firstItemRef={firstItemRef} icon={<Bot aria-hidden="true" />} label="Agent" onClick={() => onSelectCanvas?.("agent")} close={close} />
            <MenuItem icon={<ScrollText aria-hidden="true" />} label="Logs" onClick={onShowLogs} close={close} />
            <div className="topbar-more-divider" role="separator" />
          </> : null}
          <MenuItem firstItemRef={firstItemRef} icon={<Plus aria-hidden="true" />} label="Create workspace" onClick={onOpenWorkspaceModal} close={close} />
          <MenuItem disabled={!selectedWorkspace} icon={<Pencil aria-hidden="true" />} label={`Edit workspace ${workspaceLabel}`} onClick={onOpenWorkspaceEditModal} close={close} />
          <div className="topbar-more-divider" role="separator" />
          <MenuItem disabled={!selectedWorkspace} icon={<Trash2 aria-hidden="true" />} label={`Delete workspace ${workspaceLabel}`} onClick={() => onDeleteWorkspace?.(selectedWorkspace?.id)} close={close} destructive />
          <div className="topbar-more-divider" role="separator" />
          {onOpenPiAuthManage ? <MenuItem icon={<KeyRound aria-hidden="true" />} label={managePiAuthLabel} onClick={onOpenPiAuthManage} close={close} /> : null}
          <MenuItem icon={<Variable aria-hidden="true" />} label="Manage generic environment keys" onClick={onOpenGenericEnvironment} close={close} />
          <MenuItem disabled={!selectedWorkspace} icon={<PlugZap aria-hidden="true" />} label="Manage MCP servers" onClick={onOpenMcpServers} close={close} />
          <MenuItem disabled={!selectedWorkspace} icon={<Blocks aria-hidden="true" />} label="Manage Google Workspace" onClick={onOpenGoogleWorkspace} close={close} />
          <div className="topbar-more-divider" role="separator" />
          <a className="topbar-more-link" href="/community/blog" role="menuitem" onClick={close}><BookOpen aria-hidden="true" />Blog</a>
          <a className="topbar-more-link" href="/community/docs/intro/" role="menuitem" onClick={close}><BookOpen aria-hidden="true" />Docs</a>
          <div className="topbar-more-divider" role="separator" />
          <MenuItem icon={<RefreshCw aria-hidden="true" />} label="Refresh" onClick={onRefresh} close={close} />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({close, destructive = false, disabled = false, firstItemRef, icon, label, onClick}) {
  return (
    <button
      aria-label={label}
      className={`topbar-more-item${destructive ? " topbar-more-item--destructive" : ""}`}
      disabled={disabled}
      ref={firstItemRef}
      role="menuitem"
      type="button"
      onClick={() => {
        onClick?.();
        close();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
