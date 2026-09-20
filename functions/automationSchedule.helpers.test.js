"use strict";

const assert = require("node:assert/strict");
const {
  automationOccurrencesBetween,
  nextAutomationOccurrences,
  occurrenceKey,
  parseAutomationCron,
  previewAutomationSchedule,
  validateAutomationScheduleTimezone,
} = require("./automationSchedule.helpers");

assert.deepEqual(parseAutomationCron("*/5 1-2 * * 1,3"), {
  expression: "*/5 1-2 * * 1,3",
  minute: {raw: "*/5", values: new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]), wildcard: false},
  hour: {raw: "1-2", values: new Set([1, 2]), wildcard: false},
  dayOfMonth: {raw: "*", values: new Set(Array.from({length: 31}, (_, i) => i + 1)), wildcard: true},
  month: {raw: "*", values: new Set(Array.from({length: 12}, (_, i) => i + 1)), wildcard: true},
  dayOfWeek: {raw: "1,3", values: new Set([1, 3]), wildcard: false},
});
assert.throws(() => parseAutomationCron("0 10 * * * *"), /invalid_automation_cron_field_count/);
assert.throws(() => parseAutomationCron("@daily"), /invalid_automation_cron_field_count/);
assert.throws(() => parseAutomationCron("0 0 30 2 *"), /invalid_automation_cron/);
assert.throws(() => validateAutomationScheduleTimezone("Not/AZone"), /invalid_automation_timezone/);
assert.equal(validateAutomationScheduleTimezone("UTC"), "UTC");

assert.deepEqual(nextAutomationOccurrences("0 10 * * *", "America/Chicago", {
  from: new Date("2026-03-07T15:59:00.000Z"),
  count: 3,
}), [
  {utc: "2026-03-07T16:00:00.000Z", local: "2026-03-07T10:00", timezone: "America/Chicago"},
  {utc: "2026-03-08T15:00:00.000Z", local: "2026-03-08T10:00", timezone: "America/Chicago"},
  {utc: "2026-03-09T15:00:00.000Z", local: "2026-03-09T10:00", timezone: "America/Chicago"},
]);
assert.deepEqual(nextAutomationOccurrences("30 2 * * *", "America/Chicago", {
  from: new Date("2026-03-08T00:00:00.000Z"),
  count: 2,
}), [
  {utc: "2026-03-09T07:30:00.000Z", local: "2026-03-09T02:30", timezone: "America/Chicago"},
  {utc: "2026-03-10T07:30:00.000Z", local: "2026-03-10T02:30", timezone: "America/Chicago"},
]);
assert.deepEqual(nextAutomationOccurrences("30 1 * * *", "America/Chicago", {
  from: new Date("2026-11-01T00:00:00.000Z"),
  count: 2,
}), [
  {utc: "2026-11-01T06:30:00.000Z", local: "2026-11-01T01:30", timezone: "America/Chicago"},
  {utc: "2026-11-02T07:30:00.000Z", local: "2026-11-02T01:30", timezone: "America/Chicago"},
]);
assert.deepEqual(automationOccurrencesBetween("30 1 * * *", "America/Chicago",
    new Date("2026-11-01T00:00:00.000Z"), new Date("2026-11-01T08:00:00.000Z")), [
  {utc: "2026-11-01T06:30:00.000Z", local: "2026-11-01T01:30", timezone: "America/Chicago"},
]);
assert.deepEqual(nextAutomationOccurrences("0 0 1 * 1", "UTC", {
  from: new Date("2026-01-02T00:00:00.000Z"),
  count: 3,
}).map((item) => item.local), ["2026-01-05T00:00", "2026-01-12T00:00", "2026-01-19T00:00"]);
assert.deepEqual(nextAutomationOccurrences("0 0 29 2 *", "UTC", {
  from: new Date("2025-01-01T00:00:00.000Z"),
  count: 2,
}).map((item) => item.local), ["2028-02-29T00:00", "2032-02-29T00:00"]);
assert.equal(occurrenceKey("workflow-1", "2026-03-09T02:30"), "workflow-1:2026-03-09T02:30");
assert.deepEqual(previewAutomationSchedule({cron: "0 12 * * *", timezone: "UTC"}, {
  from: new Date("2026-01-01T00:00:00.000Z"),
}).occurrences.length, 5);

console.log("automation schedule helper tests passed");
