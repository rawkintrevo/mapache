import {useId} from "react";
import {
  getSessionImageFreshness,
  getSessionRunnerTags,
  getSessionStatusLabel,
  getSessionStatusTone,
} from "./sessionPresentation.js";
import "./SessionStatusSummary.css";

export function SessionStatusSummary({session}) {
  const statusTooltipId = useId();
  const imageTooltipId = useId();
  const statusLabel = getSessionStatusLabel(session?.status);
  const statusTone = getSessionStatusTone(statusLabel);
  const imageFreshness = getSessionImageFreshness(session);
  const runnerTags = getSessionRunnerTags(session);

  return (
    <span className="session-title-accessory">
      <span className="session-status-shell">
        <span
          aria-describedby={statusTooltipId}
          aria-label={`Session status: ${statusLabel}`}
          className={`session-status-light session-status-light--${statusTone}`}
          role="img"
          tabIndex={0}
        />
        <span className="session-status-tooltip" id={statusTooltipId} role="tooltip">
          {statusLabel}
        </span>
      </span>
      <span className="session-status-shell">
        <span
          aria-describedby={imageTooltipId}
          aria-label={`Image freshness: ${imageFreshness.label}`}
          className={`session-status-light session-image-light session-status-light--${imageFreshness.tone}`}
          role="img"
          tabIndex={0}
        />
        <span className="session-status-tooltip" id={imageTooltipId} role="tooltip">
          {imageFreshness.tooltip}
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
