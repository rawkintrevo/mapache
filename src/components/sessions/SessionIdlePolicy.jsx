import "./SessionIdlePolicy.css";
import {CircleHelp} from "lucide-react";
import {useEffect, useId, useRef, useState} from "react";

function idleTimeoutMinutes(session = {}) {
  const value = Number(session.idleTimeoutMinutes);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 60;
}

export function SessionIdlePolicy({disabled = false, onChange, session = {}}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const descriptionId = useId();
  const longRunning = session.longRunning === true;
  const timeout = idleTimeoutMinutes(session);

  useEffect(() => {
    if (!open) return undefined;
    function closeOnOutsideClick(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
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
    <div aria-label="Runtime lifetime" className="session-idle-policy" ref={containerRef} role="group">
      <label className="session-idle-policy__toggle">
        <input
          aria-describedby={open ? descriptionId : undefined}
          aria-label="Keep running"
          checked={longRunning}
          disabled={disabled || typeof onChange !== "function"}
          role="switch"
          type="checkbox"
          onChange={(event) => onChange?.(event.target.checked)}
        />
        <span aria-hidden="true" className="session-idle-policy__track">
          <span className="session-idle-policy__thumb" />
        </span>
        <span>Keep running</span>
      </label>
      <button
        aria-controls={descriptionId}
        aria-expanded={open}
        aria-label="About Keep running"
        className="session-idle-policy__info"
        title="About Keep running"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp aria-hidden="true" />
      </button>
      {open ? (
        <div className="session-idle-policy__popover" id={descriptionId} role="tooltip">
          On keeps background work active. Off pauses after {timeout} min idle.
        </div>
      ) : null}
    </div>
  );
}
