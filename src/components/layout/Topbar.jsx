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
        <Button disabled={state.busy} variant="secondary" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          {state.busy ? "Working..." : "Refresh"}
        </Button>
      </div>
    </header>
  );
}
