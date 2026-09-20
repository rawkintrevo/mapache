import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {Button} from "../common/Button.jsx";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted", "skipped"]);

export function RunDetailsPanel({
  busy = false,
  events = [],
  eventsNextCursor = "",
  onLoadMoreEvents,
  onRestartRun,
  onSelectRun,
  onStopRun,
  run,
}) {
  if (!run) return <aside aria-label="Run details" className="run-details-panel run-details-panel--empty"><p className="subtle">Select a run to inspect its archived history.</p></aside>;

  const status = String(run.status || "unknown").toLowerCase();
  const canStop = run.actions?.canStop ?? run.canStop ?? ["queued", "provisioning", "running"].includes(status);
  const canRestart = run.actions?.canRestart ?? run.canRestart ?? TERMINAL_STATUSES.has(status);
  const snapshot = run.snapshot || {};
  const result = run.finalResult || run.result || run.executionResult;
  const restartOfRunId = run.restartOfRunId || run.restartOf;
  const archiveLabel = run.persistenceState === "partial" || run.archiveAvailable === false ?
    "Partial archive — this summary is not a complete transcript." :
    run.archiveAvailable || run.artifactAvailable ? "Archived transcript available." : "No transcript archive was captured.";

  return (
    <aside aria-label="Run details" className="run-details-panel">
      <div className="run-details-panel__heading">
        <div>
          <p className="eyebrow">Run details</p>
          <h2>{run.automationName || snapshot.name || "Unnamed automation"}</h2>
          <p className="subtle">{run.id || run.runId}</p>
        </div>
        <span className={`automation-status automation-status--${status}`}>{status}</span>
      </div>
      <div className="run-details-panel__actions">
        {canStop ? <Button disabled={busy} variant="secondary" onClick={() => onStopRun?.(run.id || run.runId)}>Stop</Button> : null}
        {canRestart ? <Button disabled={busy} onClick={() => onRestartRun?.(run.id || run.runId)}>Restart</Button> : null}
      </div>
      <p className="run-details-panel__archive" role="status">{archiveLabel}</p>
      <section>
        <h3>Schedule and execution</h3>
        <dl className="run-details-grid">
          <Detail label="Trigger" value={run.trigger || "—"} />
          <Detail label="Scheduled local time" value={formatOccurrence(run.occurrence)} />
          <Detail label="Created" value={formatTimestamp(run.createdAt)} />
          <Detail label="Queued" value={formatTimestamp(run.queuedAt)} />
          <Detail label="Started" value={formatTimestamp(run.startedAt)} />
          <Detail label="Ended" value={formatTimestamp(run.endedAt)} />
          <Detail label="Skipped reason" value={run.skippedReason || "—"} />
          <Detail label="Cleanup" value={run.cleanupError || run.cleanupErrorCode || run.cleanupState || "—"} />
        </dl>
      </section>
      <section>
        <h3>Saved configuration</h3>
        <dl className="run-details-grid">
          <Detail label="Cron" value={snapshot.cron || "—"} />
          <Detail label="Timezone" value={snapshot.timezone || "—"} />
          <Detail label="Definition revision" value={snapshot.definitionRevision ?? "—"} />
          <Detail label="Parallel with main" value={snapshot.allowParallelWithMain === undefined ? "—" : snapshot.allowParallelWithMain ? "Allowed" : "Paused"} />
        </dl>
        <div className="run-details-markdown">
          <h4>Instructions snapshot</h4>
          <MarkdownValue value={snapshot.prompt || "No instructions were captured."} />
        </div>
      </section>
      {result !== undefined && result !== null ? (
        <section>
          <h3>Result</h3>
          <Value value={result} />
        </section>
      ) : null}
      {restartOfRunId ? (
        <section>
          <h3>Restart lineage</h3>
          <button className="run-details-link" type="button" onClick={() => onSelectRun?.(restartOfRunId)}>
            Restarted from {restartOfRunId}
          </button>
        </section>
      ) : null}
      <section>
        <div className="run-details-panel__section-heading">
          <h3>Conversation, tool events, and logs</h3>
          {eventsNextCursor ? <Button disabled={busy} size="small" variant="secondary" onClick={() => onLoadMoreEvents?.(run.id || run.runId, {append: true})}>Load more</Button> : null}
        </div>
        {events.length ? (
          <ol className="run-event-list">
            {events.map((event, index) => (
              <li key={`${event.kind || "event"}-${index}`}>
                <span className="run-event-kind">{event.kind || "event"}</span>
                <Value value={event.record} markdown={event.kind === "transcript"} />
              </li>
            ))}
          </ol>
        ) : <p className="subtle">No archived events are available for this run.</p>}
      </section>
    </aside>
  );
}

export function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(typeof value?.toDate === "function" ? value.toDate() : value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}

export function formatOccurrence(occurrence) {
  if (!occurrence) return "—";
  const local = occurrence.local || occurrence.localMinute || "—";
  const timezone = occurrence.timezone ? ` (${occurrence.timezone})` : "";
  const utc = occurrence.utc ? ` · ${formatTimestamp(occurrence.utc)} UTC` : "";
  return `${local}${timezone}${utc}`;
}

function Detail({label, value}) {
  return <><dt>{label}</dt><dd>{String(value)}</dd></>;
}

function Value({markdown = false, value}) {
  if (markdown && typeof value === "string") return <MarkdownValue value={value} />;
  if (typeof value === "string") return <p className="run-details-value">{value}</p>;
  return <pre className="run-details-json">{JSON.stringify(value, null, 2)}</pre>;
}

function MarkdownValue({value}) {
  return (
    <div className="run-details-markdown__content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(value || "")}</ReactMarkdown>
    </div>
  );
}
