import {ChevronDown, ChevronRight} from "lucide-react";
import {Button} from "../common/Button.jsx";

export function DrawerSection({actions = [], children, className = "", id, state, title, onToggleDrawerSection}) {
  const collapsedSections = state?.collapsedDrawerSections instanceof Set ? state.collapsedDrawerSections : new Set();
  const collapsed = collapsedSections.has(id);

  return (
    <section className={["drawer-section", collapsed ? "is-collapsed" : "", className].filter(Boolean).join(" ")}>
      <div className="drawer-section-heading">
        <div className="drawer-section-title">
          <Button
            aria-expanded={String(!collapsed)}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
            className="drawer-section-toggle"
            icon={true}
            title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            tooltip={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            variant="secondary"
            onClick={() => onToggleDrawerSection?.(id)}
          >
            {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </Button>
          <h3>{title}</h3>
        </div>
        {actions.length ? <div className="drawer-section-actions">{actions.map((action, index) => <span key={index}>{action}</span>)}</div> : null}
      </div>
      {collapsed ? null : children}
    </section>
  );
}
