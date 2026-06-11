function userLabel(state) {
  return (state.profile && (state.profile.displayName || state.profile.email)) ||
    state.user.email ||
    state.user.uid;
}

export function Topbar({state, onRefresh, onSignOut}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div aria-hidden="true" className="mark">pi</div>
        <h1>Mapache Tools</h1>
      </div>
      <div className="userbar">
        <span>{userLabel(state)}</span>
        <button className="secondary" disabled={state.busy} type="button" onClick={onRefresh}>
          {state.busy ? "Working..." : "Refresh"}
        </button>
        <button className="secondary" disabled={state.busy} type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
