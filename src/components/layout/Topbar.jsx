import "./Topbar.css";
import {RefreshCw} from "lucide-react";
import {Button} from "../common/Button.jsx";

export function Topbar({state, onRefresh}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div aria-hidden="true" className="mark">pi</div>
        <h1>Mapache Tools</h1>
      </div>
      <div className="topbar-actions">
        <a className="topbar-link" href="/community/blog">Blog</a>
        <a className="topbar-link" href="/community/docs/intro/">Docs</a>
        <Button
          aria-label="Refresh app state"
          disabled={state.busy}
          icon
          title={state.busy ? "Working..." : "Refresh"}
          variant="secondary"
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
