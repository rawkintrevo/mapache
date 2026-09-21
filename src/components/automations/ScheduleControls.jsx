import {useEffect, useId, useRef} from "react";

const COMMON_TIMEZONES = [
  "UTC",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const WEEKDAYS = [
  ["0", "Sunday"],
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
];

export function inferScheduleMode(cron = "") {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) return "advanced";
  if (fields[2] === "*" && fields[3] === "*" && fields[4] === "*") return "daily";
  if (fields[2] === "*" && fields[3] === "*" && /^\d+$/.test(fields[4]) && Number(fields[4]) <= 7) return "weekly";
  return "advanced";
}

export function timeFromCron(cron = "", fallback = "09:00") {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) return fallback;
  const hour = Number(fields[1]);
  const minute = Number(fields[0]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function cronForDaily(time = "09:00") {
  const [hour, minute] = splitTime(time);
  return `${minute} ${hour} * * *`;
}

export function cronForWeekly(time = "09:00", weekday = "1") {
  const [hour, minute] = splitTime(time);
  const day = /^\d+$/.test(String(weekday)) && Number(weekday) <= 7 ? String(weekday) : "1";
  return `${minute} ${hour} * * ${day}`;
}

export function validateCronShape(cron = "") {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !field || !/^[0-9*,\-/]+$/.test(field))) {
    return "Use a five-field cron expression, for example 0 9 * * *.";
  }
  return "";
}

export function validateTimezone(timezone = "") {
  if (!String(timezone).trim()) return "Choose a timezone.";
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: timezone}).format();
    return "";
  } catch {
    return "Use a valid IANA timezone, such as America/Chicago.";
  }
}

export function timezoneOptions(currentTimezone = "", userTimezone = "") {
  const values = [...COMMON_TIMEZONES, userTimezone, currentTimezone];
  if (typeof Intl.supportedValuesOf === "function") values.push(...Intl.supportedValuesOf("timeZone"));
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function useSchedulePreview({cron, timezone, onPreview, onPreviewResult, debounceMs = 350}) {
  const requestRef = useRef(0);
  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const cronError = validateCronShape(cron);
    const timezoneError = validateTimezone(timezone);
    if (cronError || timezoneError || typeof onPreview !== "function") return undefined;
    const timer = setTimeout(() => {
      Promise.resolve(onPreview(cron, timezone)).then((result) => {
        if (requestId === requestRef.current) onPreviewResult?.(result);
      }).catch((error) => {
        if (requestId === requestRef.current) onPreviewResult?.({error: error?.code || error?.message || "Could not preview schedule."});
      });
    }, Math.max(0, Number(debounceMs) || 0));
    return () => clearTimeout(timer);
  }, [cron, debounceMs, onPreview, onPreviewResult, timezone]);
}

export function ScheduleControls({
  cron,
  mode = inferScheduleMode(cron),
  onChange,
  onModeChange,
  onPreview,
  onPreviewResult,
  onTimezoneChange,
  preview = null,
  previewError = "",
  previewLoading = false,
  timezone,
  userTimezone = "",
}) {
  const listId = useId();
  const currentMode = mode === "weekly" || mode === "advanced" ? mode : "daily";
  const fields = String(cron || "").trim().split(/\s+/);
  const weekday = fields.length === 5 && /^\d+$/.test(fields[4]) ? fields[4] : "1";
  const time = timeFromCron(cron);
  const cronError = validateCronShape(cron);
  const timezoneError = validateTimezone(timezone);
  useSchedulePreview({cron, timezone, onPreview, onPreviewResult});

  function changeMode(nextMode) {
    const next = nextMode === "weekly" || nextMode === "advanced" ? nextMode : "daily";
    onModeChange?.(next);
    if (next === "daily") onChange?.(cronForDaily(time));
    if (next === "weekly") onChange?.(cronForWeekly(time, weekday));
  }

  function changeTime(nextTime) {
    if (currentMode === "weekly") onChange?.(cronForWeekly(nextTime, weekday));
    else if (currentMode === "daily") onChange?.(cronForDaily(nextTime));
  }

  const occurrences = Array.isArray(preview?.occurrences) ? preview.occurrences : [];
  return (
    <fieldset className="automation-schedule-controls">
      <legend>Schedule</legend>
      <div className="automation-schedule-controls__row">
        <label>
          Schedule type
          <select aria-label="Schedule type" value={currentMode} onChange={(event) => changeMode(event.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="advanced">Advanced cron</option>
          </select>
        </label>
        {currentMode !== "advanced" ? (
          <label>
            Time
            <input aria-label="Schedule time" type="time" value={time} onChange={(event) => changeTime(event.target.value)} />
          </label>
        ) : (
          <label className="automation-schedule-controls__cron">
            Cron expression
            <input aria-describedby={cronError ? `${listId}-cron-error` : undefined} aria-invalid={Boolean(cronError)} value={cron || ""} onChange={(event) => onChange?.(event.target.value)} />
          </label>
        )}
        {currentMode === "weekly" ? (
          <label>
            Day
            <select aria-label="Schedule day" value={weekday} onChange={(event) => onChange?.(cronForWeekly(time, event.target.value))}>
              {WEEKDAYS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {currentMode !== "advanced" ? <p className="subtle automation-schedule-controls__canonical">Canonical cron: <code>{cron || cronForDaily(time)}</code></p> : null}
      <label>
        Timezone
        <input
          aria-describedby={timezoneError ? `${listId}-timezone-error` : undefined}
          aria-invalid={Boolean(timezoneError)}
          autoComplete="off"
          list={listId}
          role="combobox"
          value={timezone || ""}
          onChange={(event) => onTimezoneChange?.(event.target.value)}
        />
        <datalist id={listId}>{timezoneOptions(timezone, userTimezone).map((value) => <option key={value} value={value} />)}</datalist>
      </label>
      {cronError ? <p className="field-error" id={`${listId}-cron-error`}>{cronError}</p> : null}
      {timezoneError ? <p className="field-error" id={`${listId}-timezone-error`}>{timezoneError}</p> : null}
      <div aria-live="polite" className="automation-schedule-preview">
        <div className="automation-schedule-preview__heading">
          <strong>Next five runs</strong>
          {previewLoading ? <span className="subtle">Checking schedule...</span> : null}
        </div>
        {previewError ? <p className="field-error">{previewError}</p> : null}
        {occurrences.length ? <ol>{occurrences.map((occurrence, index) => <li key={`${occurrence.utc || occurrence.local}-${index}`}><span>{occurrence.local} {occurrence.timezone}</span><span className="subtle">{formatUtcOccurrence(occurrence)}</span></li>)}</ol> : !previewLoading && !previewError ? <p className="subtle">Enter a valid schedule to preview upcoming runs.</p> : null}
        <p className="subtle automation-schedule-preview__note">Spring-forward gaps are skipped; a repeated fall-back local time runs once.</p>
      </div>
    </fieldset>
  );
}

function splitTime(time) {
  const [hour, minute] = String(time || "09:00").split(":");
  return [
    String(Number.isInteger(Number(hour)) && Number(hour) >= 0 && Number(hour) <= 23 ? Number(hour) : 9),
    String(Number.isInteger(Number(minute)) && Number(minute) >= 0 && Number(minute) <= 59 ? Number(minute) : 0),
  ];
}

function formatUtcOccurrence(occurrence) {
  if (!occurrence?.utc) return "UTC unavailable";
  const date = new Date(occurrence.utc);
  if (Number.isNaN(date.getTime())) return "UTC unavailable";
  const utc = date.toISOString().replace("T", " ").replace(".000Z", " UTC");
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en-US", {timeZone: occurrence.timezone, timeZoneName: "shortOffset"})
        .formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "";
  } catch {
    offset = "";
  }
  return `${utc}${offset ? ` (${offset})` : ""}`;
}
