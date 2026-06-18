import "./GlobalActionIndicator.css";
import {LoaderCircle} from "lucide-react";

export function GlobalActionIndicator({busy, message = "Working..."}) {
  if (!busy) return null;

  const statusMessage = message || "Working...";

  return (
    <div aria-atomic="true" aria-live="polite" className="global-action-indicator" role="status">
      <LoaderCircle aria-hidden="true" className="global-action-indicator__icon" />
      <span>{statusMessage}</span>
    </div>
  );
}
