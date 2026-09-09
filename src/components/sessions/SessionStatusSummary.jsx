import {useId} from "react";
import {getSessionImageFreshness, getSessionRunnerTags, getSessionStatusLabel, getSessionStatusTone} from "./sessionPresentation.js";
import "./SessionStatusSummary.css";

export function SessionStatusSummary({session}) {
  const tooltipId = useId();
  const statusLabel = getSessionStatusLabel(session);
  const statusTone = getSessionStatusTone(statusLabel);
  const imageFreshness = getSessionImageFreshness(session);
  const runnerTags = getSessionRunnerTags(session);

  return (
    <span className="session-title-accessory">
      <span className="session-status-shell">
        <span
          aria-describedby={tooltipId}
          aria-label={`Session status: ${statusLabel}`}
          className={`session-status-light session-status-light--${statusTone}`}
          role="img"
          tabIndex={0}
        />
        <span className="session-status-tooltip" id={tooltipId} role="tooltip">
          {statusLabel}
        </span>
      </span>
      <span className="session-image-freshness-shell">
        <span
          aria-label={`Image freshness: ${imageFreshness.label}`}
          className={`session-image-freshness session-image-freshness--${imageFreshness.tone}`}
          role="img"
          tabIndex={0}
          title={imageFreshness.message}
        />
        <span className="session-image-freshness-tooltip" role="tooltip">
          {imageFreshness.message}
        </span>
      </span>
      {runnerTags.length ? (
        <span className="session-runner-tags" aria-label={`Runner tags: ${runnerTags.join(", ")}`}>
          {runnerTags.map((tag, index) => (
            <span className="session-runner-tag" key={`${tag}-${index}`}>
              {tag}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
