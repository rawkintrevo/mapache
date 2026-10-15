"use strict";

const DAY_MINUTES = 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEKDAY_NUMBERS = Object.freeze({Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6});
const formatterCache = new Map();

function validateRuntimeTimezone(value) {
  const timezone = String(value || "").trim();
  if (!timezone || timezone.length > 100) throw runtimeScheduleError("invalid_runtime_schedule_timezone");
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: timezone}).format(new Date(0));
  } catch (error) {
    throw runtimeScheduleError("invalid_runtime_schedule_timezone");
  }
  return timezone;
}

function normalizeRuntimeSchedule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeScheduleError("invalid_runtime_schedule");
  }
  const days = [...new Set((Array.isArray(value.days) ? value.days : []).map(Number))].sort((a, b) => a - b);
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw runtimeScheduleError("invalid_runtime_schedule_days");
  }
  const startTime = normalizeTime(value.startTime);
  const endTime = normalizeTime(value.endTime);
  if (minutesOfDay(startTime) >= minutesOfDay(endTime)) {
    throw runtimeScheduleError("runtime_schedule_must_end_same_day");
  }
  return {
    days,
    startTime,
    endTime,
    timezone: validateRuntimeTimezone(value.timezone),
  };
}

function normalizeRuntimePolicy(value, current = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeScheduleError("invalid_runtime_policy");
  }
  const mode = String(value.mode || "").trim().toLowerCase();
  if (!["idle", "keep-running", "scheduled"].includes(mode)) {
    throw runtimeScheduleError("invalid_runtime_policy_mode");
  }
  const scheduleValue = Object.prototype.hasOwnProperty.call(value, "schedule") ? value.schedule : current.schedule;
  const schedule = scheduleValue === null || scheduleValue === undefined || scheduleValue === "" ?
    null : normalizeRuntimeSchedule(scheduleValue);
  if (mode === "scheduled" && !schedule) throw runtimeScheduleError("runtime_schedule_required");
  return {mode, schedule};
}

function getRuntimeScheduleState(scheduleValue, nowValue = new Date()) {
  const schedule = normalizeRuntimeSchedule(scheduleValue);
  const timezone = schedule.timezone;
  const now = asDate(nowValue);
  const local = localDateTimeParts(now, timezone);
  const today = local.dateKey;
  const todayOccurrence = occurrenceForDate(schedule, today);
  if (todayOccurrence && now.getTime() >= todayOccurrence.start.getTime() && now.getTime() < todayOccurrence.end.getTime()) {
    return {
      active: true,
      windowKey: today,
      nextEvent: {action: "stop", at: todayOccurrence.end, windowKey: today},
    };
  }

  const startAfter = todayOccurrence && todayOccurrence.start.getTime() > now.getTime() ? todayOccurrence.start : null;
  if (startAfter) {
    return {
      active: false,
      windowKey: null,
      nextEvent: {action: "start", at: startAfter, windowKey: today},
    };
  }

  for (let dayOffset = 1; dayOffset <= 8; dayOffset++) {
    const dateKey = addLocalDays(today, dayOffset);
    const occurrence = occurrenceForDate(schedule, dateKey);
    if (occurrence && occurrence.start.getTime() > now.getTime()) {
      return {
        active: false,
        windowKey: null,
        nextEvent: {action: "start", at: occurrence.start, windowKey: dateKey},
      };
    }
  }
  throw runtimeScheduleError("runtime_schedule_next_event_unavailable");
}

function runtimeScheduleWindowKey(scheduleValue, nowValue = new Date()) {
  const state = getRuntimeScheduleState(scheduleValue, nowValue);
  return state.active ? state.windowKey : null;
}

function getNextRuntimeScheduleStart(scheduleValue, nowValue = new Date()) {
  const schedule = normalizeRuntimeSchedule(scheduleValue);
  const now = asDate(nowValue);
  const today = localDateTimeParts(now, schedule.timezone).dateKey;
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const dateKey = addLocalDays(today, dayOffset);
    const occurrence = occurrenceForDate(schedule, dateKey);
    if (occurrence && occurrence.start.getTime() > now.getTime()) {
      return {action: "start", at: occurrence.start, windowKey: dateKey};
    }
  }
  throw runtimeScheduleError("runtime_schedule_next_event_unavailable");
}

function occurrenceForDate(schedule, dateKey) {
  const date = parseDateKey(dateKey);
  const weekday = isoWeekday(date.year, date.month, date.day);
  if (!schedule.days.includes(weekday)) return null;
  return {
    dateKey,
    start: resolveLocalBoundary(date, schedule.startTime, schedule.timezone, "start"),
    end: resolveLocalBoundary(date, schedule.endTime, schedule.timezone, "end"),
  };
}

function resolveLocalBoundary(date, time, timezone, boundary) {
  const {hour, minute} = parseTime(time);
  const targetUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const targetLocalScalar = targetUtc;
  const offsets = new Set([-36, -12, 0, 12, 36].map((hours) => timezoneOffsetAt(targetUtc + hours * 60 * MINUTE_MS, timezone)));
  const matches = [];
  const shifted = [];
  for (const offset of offsets) {
    const instant = targetUtc - offset;
    const parts = localDateTimeParts(new Date(instant), timezone);
    const scalar = localScalar(parts);
    if (scalar === targetLocalScalar) matches.push(instant);
    else if (scalar > targetLocalScalar) shifted.push({instant, scalar});
  }
  if (matches.length) {
    matches.sort((a, b) => a - b);
    return new Date(boundary === "end" ? matches[matches.length - 1] : matches[0]);
  }
  if (!shifted.length) throw runtimeScheduleError("runtime_schedule_boundary_unavailable");

  // A boundary in a spring-forward gap resolves to the first valid local
  // minute after the gap, rather than preserving its minute offset into it.
  shifted.sort((a, b) => a.scalar - b.scalar || a.instant - b.instant);
  let instant = shifted[0].instant;
  for (let step = 0; step < DAY_MINUTES; step++) {
    const previous = instant - MINUTE_MS;
    if (localScalar(localDateTimeParts(new Date(previous), timezone)) < targetLocalScalar) break;
    instant = previous;
  }
  return new Date(instant);
}

function timezoneOffsetAt(instant, timezone) {
  const date = new Date(instant);
  const parts = localDateTimeParts(date, timezone);
  return localScalar(parts) - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

function localDateTimeParts(value, timezone) {
  const date = asDate(value);
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    formatterCache.set(timezone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const dateKey = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {year, month, day, hour, minute, weekday: WEEKDAY_NUMBERS[values.weekday], dateKey};
}

function localScalar(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function addLocalDays(dateKey, count) {
  const date = parseDateKey(dateKey);
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + count));
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw runtimeScheduleError("invalid_runtime_schedule_date");
  return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3])};
}

function isoWeekday(year, month, day) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function normalizeTime(value) {
  const time = String(value || "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw runtimeScheduleError("invalid_runtime_schedule_time");
  return time;
}

function parseTime(value) {
  const [hour, minute] = value.split(":").map(Number);
  return {hour, minute};
}

function minutesOfDay(value) {
  const {hour, minute} = parseTime(value);
  return hour * 60 + minute;
}

function asDate(value) {
  const date = value instanceof Date ? value : value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw runtimeScheduleError("invalid_runtime_schedule_time");
  return date;
}

function runtimeScheduleError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

module.exports = {
  getNextRuntimeScheduleStart,
  getRuntimeScheduleState,
  normalizeRuntimePolicy,
  normalizeRuntimeSchedule,
  runtimeScheduleWindowKey,
  validateRuntimeTimezone,
};
