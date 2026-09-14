import {Button} from "../common/Button.jsx";
import {
  formatSessionCheckpointTime,
  getSessionRuntimeError,
  getSessionRuntimeStatus,
  isMarkedRuntimeSession,
  isRuntimeStopUncertain,
} from "./sessionPresentation.js";

export function SessionRuntimeStatus({session, accessError = "", onRetryAccess}) {
  if (!isMarkedRuntimeSession(session)) return null;

  const runtime = getSessionRuntimeStatus(session);
  const runtimeError = getSessionRuntimeError(session);
  const stopUncertain = isRuntimeStopUncertain(session);

  return (
    <section
      aria-label="Agent runtime status"
      aria-live="polite"
      className={`session-runtime-status session-runtime-status--${runtime.tone}`}
    >
      <div className="session-runtime-status__summary">
        <strong>{runtime.label}</strong>
        <span>{runtime.message}</span>
      </div>
      <dl className="session-runtime-status__details">
        <div>
          <dt>Last successful checkpoint</dt>
          <dd>{formatSessionCheckpointTime(session.agentRuntimeLastCheckpointAt)}</dd>
        </div>
        {session.agentRuntimeGeneration ? (
          <div>
            <dt>Runtime generation</dt>
            <dd>{session.agentRuntimeGeneration}</dd>
          </div>
        ) : null}
      </dl>
      {runtimeError ? (
        <div className="session-runtime-status__error" role="alert">
          <strong>Persistence or lifecycle error</strong>
          <span>
            {stopUncertain ?
              "The server has not confirmed a safe stop. Leave Restart disabled until this state resolves." :
              "The server will clear this message after a successful recovery or checkpoint."}
          </span>
          <code>{runtimeError}</code>
        </div>
      ) : null}
      {accessError ? (
        <div className="session-runtime-status__access" role="alert">
          <strong>Browser access unavailable</strong>
          <span>The runtime status above comes from the server and is independent of this browser connection.</span>
          <code>{accessError}</code>
          {typeof onRetryAccess === "function" ? (
            <Button variant="secondary" onClick={() => onRetryAccess({clear: true})}>
              Retry browser access
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
