import {Activity, LogOut, RefreshCw, ShieldCheck, User} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {Button} from "../common/Button.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

function userLabel(state) {
  return (state.profile && (state.profile.displayName || state.profile.email)) ||
    state.user?.email ||
    state.user?.uid ||
    "User";
}

function userEmail(state) {
  return (state.profile && state.profile.email) || state.user?.email || "";
}

function userPhoto(state) {
  return (state.profile && state.profile.photoURL) || state.user?.photoURL || "";
}

function initials(label) {
  return String(label || "U")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase() || "U";
}

export function TopbarUserMenu({state, onRefresh, onShowAdmin, onShowInstances, onShowProfile, onSignOut}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const label = userLabel(state);
  const email = userEmail(state);
  const photo = userPhoto(state);
  const busy = hasPendingOperations(state.pendingOperations);

  useEffect(() => {
    if (!open) return undefined;
    function closeOnOutsideClick(event) {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="topbar-user-menu" ref={menuRef}>
      <Button
        aria-expanded={String(open)}
        aria-haspopup="menu"
        aria-label={`Open user menu for ${label}`}
        className="topbar-user-button"
        icon
        title={`User menu: ${label}`}
        tooltip={`User menu: ${label}`}
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar label={label} photo={photo} />
      </Button>
      {open ? (
        <div aria-label="User menu" className="topbar-user-popover" role="menu">
          <div className="topbar-user-profile">
            <Avatar label={label} photo={photo} />
            <div>
              <strong>{label}</strong>
              {email && email !== label ? <span>{email}</span> : null}
            </div>
          </div>
          <ul className="topbar-user-list-group" role="list">
            <li>
              <MenuButton icon={<User aria-hidden="true" />} label="Profile" onClick={onShowProfile} close={() => setOpen(false)} />
            </li>
            {state.profile?.isAdmin === true ? (
              <li>
                <MenuButton icon={<ShieldCheck aria-hidden="true" />} label="Admin" onClick={onShowAdmin} close={() => setOpen(false)} />
              </li>
            ) : null}
            <li>
              <MenuButton icon={<Activity aria-hidden="true" />} label="Running instances" onClick={onShowInstances} close={() => setOpen(false)} />
            </li>
            <li>
              <MenuButton disabled={busy} icon={<RefreshCw aria-hidden="true" />} label={busy ? "Working..." : "Refresh"} onClick={onRefresh} close={() => setOpen(false)} />
            </li>
            <li>
              <MenuButton disabled={busy} icon={<LogOut aria-hidden="true" />} label="Sign out" onClick={onSignOut} close={() => setOpen(false)} />
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function MenuButton({close, disabled = false, icon, label, onClick}) {
  return (
    <button
      className="topbar-user-list-item"
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => {
        onClick?.();
        close();
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Avatar({label, photo}) {
  if (photo) {
    return <img alt="" className="topbar-user-avatar" referrerPolicy="no-referrer" src={photo} />;
  }
  return <span aria-hidden="true" className="topbar-user-avatar topbar-user-avatar-fallback">{initials(label)}</span>;
}
