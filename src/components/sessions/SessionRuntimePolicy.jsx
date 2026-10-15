import "./SessionRuntimePolicy.css";
import {useEffect, useId, useState} from "react";

const WEEKDAYS = [
  {label: "Mon", value: 1},
  {label: "Tue", value: 2},
  {label: "Wed", value: 3},
  {label: "Thu", value: 4},
  {label: "Fri", value: 5},
  {label: "Sat", value: 6},
  {label: "Sun", value: 7},
];

function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function makeDraft(workspace = {}, session = {}) {
  const stored = workspace.runtimePolicy;
  const mode = ["idle", "keep-running", "scheduled"].includes(stored?.mode) ?
    stored.mode : session.longRunning === true ? "keep-running" : "idle";
  const source = stored?.schedule || null;
  return {
    mode,
    schedule: source ? {
      days: [...(source.days || [])],
      startTime: source.startTime || "",
      endTime: source.endTime || "",
      timezone: source.timezone || browserTimezone(),
    } : null,
  };
}

function summarizeDays(days = []) {
  const selected = WEEKDAYS.filter((day) => days.includes(day.value)).map((day) => day.label);
  if (selected.length === 7) return "Every day";
  if (selected.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return "Mon–Fri";
  return selected.join(", ") || "No days selected";
}

function nextEventText(event, timezone) {
  if (!event?.at || !event?.action) return "Next start or stop is being calculated.";
  const date = new Date(event.at);
  if (!Number.isFinite(date.getTime())) return "Next start or stop is being calculated.";
  const formatted = new Intl.DateTimeFormat(undefined, {
    timeZone: event.timezone || timezone || "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `Next scheduled ${event.action}: ${formatted}`;
}

export function SessionRuntimePolicy({disabled = false, onSave, session = {}, workspace = {}}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => makeDraft(workspace, session));
  const descriptionId = useId();
  const schedule = draft.schedule;
  const savedPolicy = makeDraft(workspace, session);
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(savedPolicy);
  const timeout = Number(session.idleTimeoutMinutes) > 0 ? Math.round(Number(session.idleTimeoutMinutes)) : 60;

  useEffect(() => {
    setDraft(makeDraft(workspace, session));
  }, [workspace.id, workspace.runtimePolicyRevision, workspace.runtimePolicy, session.id, session.longRunning]);

  function selectMode(mode) {
    setDraft((current) => ({
      ...current,
      mode,
      schedule: current.schedule || (mode === "scheduled" ? {
        days: [], startTime: "", endTime: "", timezone: browserTimezone(),
      } : null),
    }));
  }

  function updateSchedule(key, value) {
    setDraft((current) => ({
      ...current,
      schedule: {...(current.schedule || {days: [], startTime: "", endTime: "", timezone: browserTimezone()}), [key]: value},
    }));
  }

  function toggleWeekday(dayValue) {
    updateSchedule("days", schedule?.days?.includes(dayValue) ?
      schedule.days.filter((day) => day !== dayValue) : [...(schedule?.days || []), dayValue].sort((a, b) => a - b));
  }

  async function save() {
    if (typeof onSave !== "function" || disabled) return;
    const schedulePayload = schedule?.days?.length && schedule.startTime && schedule.endTime && schedule.timezone ? schedule : null;
    const saved = await onSave({mode: draft.mode, schedule: schedulePayload});
    if (saved !== false) setOpen(false);
  }

  const modeLabel = draft.mode === "scheduled" ? "Scheduled hours" :
    draft.mode === "keep-running" ? "Keep running" : "Idle timeout";
  const status = workspace.runtimeScheduleStatus;
  const error = workspace.runtimeScheduleError;

  return (
    <div aria-label="Runtime policy" className="session-runtime-policy" role="group">
      <button
        aria-controls={descriptionId}
        aria-expanded={open}
        className="session-runtime-policy__trigger"
        disabled={disabled}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{modeLabel}</span>
        <span aria-hidden="true" className={`session-runtime-policy__status session-runtime-policy__status--${status || "idle"}`} />
      </button>
      {open ? (
        <section aria-label="Runtime policy settings" className="session-runtime-policy__popover" id={descriptionId}>
          <label className="session-runtime-policy__field">
            <span>Runtime policy</span>
            <select
              aria-label="Runtime policy mode"
              disabled={disabled}
              value={draft.mode}
              onChange={(event) => selectMode(event.target.value)}
            >
              <option value="idle">Idle timeout</option>
              <option value="keep-running">Keep running</option>
              <option value="scheduled">Scheduled hours</option>
            </select>
          </label>

          {draft.mode === "idle" ? <p className="session-runtime-policy__summary">Pauses after {timeout} minutes without activity.</p> : null}
          {draft.mode === "keep-running" ? <p className="session-runtime-policy__summary">Remains available until you pause it.</p> : null}

          {schedule ? (
            <div className="session-runtime-policy__schedule">
              <fieldset disabled={disabled}>
                <legend>Days</legend>
                <div className="session-runtime-policy__days">
                  {WEEKDAYS.map((day) => (
                    <button
                      aria-pressed={schedule.days.includes(day.value)}
                      className="session-runtime-policy__day"
                      key={day.value}
                      type="button"
                      onClick={() => toggleWeekday(day.value)}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="session-runtime-policy__times">
                <label className="session-runtime-policy__field">
                  <span>Start</span>
                  <input aria-label="Schedule start time" disabled={disabled} type="time" value={schedule.startTime}
                    onChange={(event) => updateSchedule("startTime", event.target.value)} />
                </label>
                <label className="session-runtime-policy__field">
                  <span>End</span>
                  <input aria-label="Schedule end time" disabled={disabled} type="time" value={schedule.endTime}
                    onChange={(event) => updateSchedule("endTime", event.target.value)} />
                </label>
              </div>
              <label className="session-runtime-policy__field">
                <span>Time zone</span>
                <input aria-label="Schedule time zone" autoComplete="off" disabled={disabled} type="text"
                  value={schedule.timezone} onChange={(event) => updateSchedule("timezone", event.target.value)} />
              </label>
              <p className="session-runtime-policy__summary">
                {summarizeDays(schedule.days)} · {schedule.startTime || "—"}–{schedule.endTime || "—"} {schedule.timezone || ""}
              </p>
              {draft.mode === "scheduled" ? (
                <>
                  <p className="session-runtime-policy__summary">
                    {status === "manually_paused" ? "Manually paused until the next scheduled opening." :
                      status === "open" ? "Scheduled hours are open now." : "Scheduled hours are currently closed."}
                  </p>
                  <p className="session-runtime-policy__summary">{nextEventText(workspace.runtimeScheduleNextEvent, schedule.timezone)}</p>
                  {error?.code ? (
                    <p className="session-runtime-policy__error" role="status">
                      Scheduled {error.action === "stop" ? "shutdown" : "startup"} failed ({error.code}); retrying while scheduled hours remain open.
                    </p>
                  ) : null}
                  <p className="session-runtime-policy__notice">
                    At closing time, active agent turns and shell jobs are interrupted. Live processes do not resume.
                    Hours follow this time zone through daylight-saving changes. A missing spring-forward time uses
                    the first valid time; repeated fall-back hours count as one continuous window.
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="session-runtime-policy__actions">
            <button disabled={disabled || !hasChanges} type="button" onClick={save}>Save policy</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
