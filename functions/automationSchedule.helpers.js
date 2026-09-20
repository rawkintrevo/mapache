"use strict";

const {CronExpressionParser} = require("cron-parser");
const {
  AUTOMATION_CRON_MAX_LENGTH,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
  validateAutomationCron,
  validateAutomationTimezone,
} = require("./automationValidation.helpers");

const SEARCH_HORIZON_YEARS = 8;
const MAX_CANDIDATES_TO_INSPECT = 100000;
const PREVIEW_OCCURRENCE_COUNT = 5;

const CRON_FIELD_RANGES = Object.freeze([
  {name: "minute", min: 0, max: 59},
  {name: "hour", min: 0, max: 23},
  {name: "dayOfMonth", min: 1, max: 31},
  {name: "month", min: 1, max: 12},
  {name: "dayOfWeek", min: 0, max: 7},
]);

function scheduleError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function parseCronField(value, range) {
  const raw = String(value || "");
  if (!raw) throw scheduleError("invalid_automation_cron", {field: range.name});
  const values = new Set();
  for (const segment of raw.split(",")) {
    if (!segment) throw scheduleError("invalid_automation_cron", {field: range.name});
    const [base, rawStep] = segment.split("/");
    if (segment.split("/").length > 2) throw scheduleError("invalid_automation_cron", {field: range.name});
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1) throw scheduleError("invalid_automation_cron", {field: range.name});

    let start = range.min;
    let end = range.max;
    if (base !== "*") {
      const match = base.match(/^(\d+)(?:-(\d+))?$/);
      if (!match) throw scheduleError("invalid_automation_cron", {field: range.name});
      start = Number(match[1]);
      end = match[2] === undefined ? start : Number(match[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw scheduleError("invalid_automation_cron", {field: range.name});
      }
    }
    if (start < range.min || end > range.max) throw scheduleError("invalid_automation_cron", {field: range.name});
    for (let item = start; item <= end; item += step) values.add(item);
  }
  if (!values.size) throw scheduleError("invalid_automation_cron", {field: range.name});
  return {
    raw,
    values,
    wildcard: raw === "*",
  };
}

function parseAutomationCron(expression) {
  const cron = validateAutomationCron(expression);
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) throw scheduleError("invalid_automation_cron_field_count");
  const parsed = CRON_FIELD_RANGES.map((range, index) => parseCronField(fields[index], range));
  try {
    // cron-parser catches calendar-impossible combinations such as February 30.
    CronExpressionParser.parse(cron, {
      currentDate: new Date("2000-01-01T00:00:00.000Z"),
      tz: "UTC",
    });
  } catch (error) {
    throw scheduleError("invalid_automation_cron", {cause: error});
  }
  return {
    expression: cron,
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
  };
}

function validateAutomationScheduleTimezone(value) {
  const timezone = validateAutomationTimezone(value);
  if (timezone.length > AUTOMATION_TIMEZONE_MAX_LENGTH) {
    throw scheduleError("invalid_automation_timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: timezone}).format();
  } catch (error) {
    throw scheduleError("invalid_automation_timezone", {cause: error});
  }
  return timezone;
}

function localDateTimeParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function formatLocalMinute(date, timezone) {
  const parts = localDateTimeParts(date, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-` +
    `${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:` +
    `${String(parts.minute).padStart(2, "0")}`;
}

function matchesAutomationCron(parts, parsed) {
  if (!parsed.minute.values.has(parts.minute) ||
      !parsed.hour.values.has(parts.hour) ||
      !parsed.month.values.has(parts.month)) return false;
  const dayOfMonthMatches = parsed.dayOfMonth.values.has(parts.day);
  const normalizedDayOfWeek = parts.dayOfWeek === 0 ? [0, 7] : [parts.dayOfWeek];
  const dayOfWeekMatches = normalizedDayOfWeek.some((day) => parsed.dayOfWeek.values.has(day));
  if (parsed.dayOfMonth.wildcard || parsed.dayOfWeek.wildcard) {
    return dayOfMonthMatches && dayOfWeekMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw scheduleError("invalid_automation_schedule_start");
  return date;
}

function searchHorizon(start) {
  const horizon = new Date(start.getTime());
  horizon.setUTCFullYear(horizon.getUTCFullYear() + SEARCH_HORIZON_YEARS);
  return horizon;
}

function nextAutomationOccurrences(expression, timezone, options = {}) {
  const parsed = parseAutomationCron(expression);
  const normalizedTimezone = validateAutomationScheduleTimezone(timezone);
  const start = asDate(options.from || options.currentDate || new Date());
  const count = Math.max(1, Math.min(Number(options.count || PREVIEW_OCCURRENCE_COUNT), 50));
  const horizon = searchHorizon(start);
  let parser;
  try {
    parser = CronExpressionParser.parse(parsed.expression, {
      currentDate: start,
      tz: normalizedTimezone,
    });
  } catch (error) {
    throw scheduleError("invalid_automation_cron", {cause: error});
  }

  const occurrences = [];
  const localKeys = new Set();
  for (let inspected = 0; inspected < MAX_CANDIDATES_TO_INSPECT && occurrences.length < count; inspected++) {
    let candidate;
    try {
      candidate = parser.next();
    } catch (error) {
      throw scheduleError("no_automation_occurrence", {cause: error});
    }
    const date = candidate && typeof candidate.toDate === "function" ? candidate.toDate() : new Date(candidate);
    if (!(date instanceof Date) || Number.isNaN(date.getTime()) || date > horizon) break;
    const localParts = localDateTimeParts(date, normalizedTimezone);
    const local = formatLocalMinute(date, normalizedTimezone);
    if (!matchesAutomationCron(localParts, parsed) || localKeys.has(local)) continue;
    localKeys.add(local);
    occurrences.push({
      utc: date.toISOString(),
      local,
      timezone: normalizedTimezone,
    });
  }
  if (occurrences.length < count) throw scheduleError("no_automation_occurrence");
  return occurrences;
}

function nextAutomationOccurrence(expression, timezone, options = {}) {
  return nextAutomationOccurrences(expression, timezone, {...options, count: 1})[0];
}

function occurrenceKey(workflowId, localMinute) {
  const id = String(workflowId || "").trim();
  const local = String(localMinute || "").trim();
  if (!id || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) {
    throw scheduleError("invalid_automation_occurrence_key");
  }
  return `${id}:${local}`;
}

function previewAutomationSchedule(payload = {}, options = {}) {
  const cron = payload && payload.cron;
  const timezone = payload && payload.timezone;
  return {
    occurrences: nextAutomationOccurrences(cron, timezone, {
      ...options,
      count: PREVIEW_OCCURRENCE_COUNT,
    }),
  };
}

module.exports = {
  AUTOMATION_CRON_MAX_LENGTH,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
  MAX_CANDIDATES_TO_INSPECT,
  PREVIEW_OCCURRENCE_COUNT,
  SEARCH_HORIZON_YEARS,
  formatLocalMinute,
  matchesAutomationCron,
  nextAutomationOccurrence,
  nextAutomationOccurrences,
  occurrenceKey,
  parseAutomationCron,
  previewAutomationSchedule,
  validateAutomationScheduleTimezone,
};
