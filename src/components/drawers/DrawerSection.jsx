export function DrawerSection({actions = [], children, className = "", id, state, title, onToggleDrawerSection}) {
  const collapsedSections = state?.collapsedDrawerSections instanceof Set ? state.collapsedDrawerSections : new Set();
  const collapsed = collapsedSections.has(id);

  return (
    <section className={["drawer-section", collapsed ? "is-collapsed" : "", className].filter(Boolean).join(" ")}>
      <div className="drawer-section-heading">
        <div className="drawer-section-title">
          <button
            aria-expanded={String(!collapsed)}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
            className="drawer-section-toggle secondary"
            title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            type="button"
            onClick={() => onToggleDrawerSection?.(id)}
          >
            <span aria-hidden="true" className="icon">{collapsed ? "▸" : "▾"}</span>
          </button>
          <h3>{title}</h3>
        </div>
        {actions.map((action, index) => <span key={index}>{action}</span>)}
      </div>
      {collapsed ? null : children}
    </section>
  );
}
