import "./SessionIdlePolicy.css";

function idleTimeoutMinutes(session = {}) {
  const value = Number(session.idleTimeoutMinutes);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 60;
}

export function SessionIdlePolicy({disabled = false, onChange, session = {}}) {
  const longRunning = session.longRunning === true;
  const timeout = idleTimeoutMinutes(session);

  return (
    <section aria-label="Automatic pause policy" className="session-idle-policy">
      <div className="session-idle-policy__main">
        <div>
          <strong>Runtime lifetime</strong>
          <p id="session-idle-policy-description">
            {longRunning ?
              "Long-running is on. Automatic pause is disabled so background agent work can continue." :
              `Long-running is off. Automatically pauses after ${timeout} minutes without activity.`}
          </p>
        </div>
        <label className="session-idle-policy__toggle">
          <input
            aria-describedby="session-idle-policy-description"
            aria-label="Long-running"
            checked={longRunning}
            disabled={disabled || typeof onChange !== "function"}
            type="checkbox"
            onChange={(event) => onChange?.(event.target.checked)}
          />
          <span>Long-running</span>
        </label>
      </div>
      <small>Manual Pause remains available in either state.</small>
    </section>
  );
}
