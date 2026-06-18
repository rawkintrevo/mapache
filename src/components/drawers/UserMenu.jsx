import {LogOut, RefreshCw, ShieldCheck, User} from "lucide-react";
import {useState} from "react";
import {Button} from "../common/Button.jsx";

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

export function UserMenu({state, onRefresh, onShowAdmin, onShowProfile, onSignOut}) {
  const [open, setOpen] = useState(false);
  const label = userLabel(state);
  const email = userEmail(state);
  const photo = userPhoto(state);

  return (
    <div className="drawer-user-menu">
      {open ? (
        <div className="drawer-user-popover" role="menu">
          <div className="drawer-user-profile">
            <Avatar label={label} photo={photo} />
            <div>
              <strong>{label}</strong>
              {email && email !== label ? <span>{email}</span> : null}
            </div>
          </div>
          <ul className="drawer-user-list-group" role="list">
            <li>
              <button
                className="drawer-user-list-item"
                role="menuitem"
                type="button"
                onClick={() => {
                  onShowProfile?.();
                  setOpen(false);
                }}
              >
                <User aria-hidden="true" />
                Profile
              </button>
            </li>
            {state.profile?.isAdmin === true ? (
              <li>
                <button
                  className="drawer-user-list-item"
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    onShowAdmin?.();
                    setOpen(false);
                  }}
                >
                  <ShieldCheck aria-hidden="true" />
                  Admin
                </button>
              </li>
            ) : null}
            <li>
              <button
                className="drawer-user-list-item"
                disabled={state.busy}
                role="menuitem"
                type="button"
                onClick={onRefresh}
              >
                <RefreshCw aria-hidden="true" />
                {state.busy ? "Working..." : "Refresh"}
              </button>
            </li>
            <li>
              <button
                className="drawer-user-list-item"
                disabled={state.busy}
                role="menuitem"
                type="button"
                onClick={onSignOut}
              >
                <LogOut aria-hidden="true" />
                Sign out
              </button>
            </li>
          </ul>
        </div>
      ) : null}
      <Button
        aria-expanded={String(open)}
        aria-haspopup="menu"
        className="drawer-user-button"
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar label={label} photo={photo} />
        <span>{label}</span>
      </Button>
    </div>
  );
}

function Avatar({label, photo}) {
  if (photo) {
    return <img alt="" className="drawer-user-avatar" referrerPolicy="no-referrer" src={photo} />;
  }
  return <span aria-hidden="true" className="drawer-user-avatar drawer-user-avatar-fallback">{initials(label)}</span>;
}
