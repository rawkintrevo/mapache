export function Topbar({state, onRefresh}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div aria-hidden="true" className="mark">pi</div>
        <h1>Mapache Tools</h1>
      </div>
      <div className="topbar-actions">
        <button className="secondary" disabled={state.busy} type="button" onClick={onRefresh}>
          {state.busy ? "Working..." : "Refresh"}
        </button>
      </div>
    </header>
  );
}
