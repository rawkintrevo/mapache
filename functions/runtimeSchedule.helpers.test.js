"use strict";

const assert = require("node:assert/strict");
const {
  getRuntimeScheduleState,
  normalizeRuntimePolicy,
  normalizeRuntimeSchedule,
} = require("./runtimeSchedule.helpers");

const weekdays = {days: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00", timezone: "America/Chicago"};

assert.deepEqual(normalizeRuntimePolicy({mode: "scheduled", schedule: weekdays}), {
  mode: "scheduled",
  schedule: weekdays,
});
assert.throws(() => normalizeRuntimeSchedule({...weekdays, endTime: "07:59"}), /runtime_schedule_must_end_same_day/);
assert.throws(() => normalizeRuntimeSchedule({...weekdays, timezone: "No/Such_Zone"}), /invalid_runtime_schedule_timezone/);
assert.throws(() => normalizeRuntimePolicy({mode: "scheduled"}), /runtime_schedule_required/);

const mondayBeforeOpen = getRuntimeScheduleState(weekdays, new Date("2026-10-19T12:59:00.000Z"));
assert.equal(mondayBeforeOpen.active, false);
assert.equal(mondayBeforeOpen.nextEvent.action, "start");
assert.equal(mondayBeforeOpen.nextEvent.at.toISOString(), "2026-10-19T13:00:00.000Z");

const mondayWithinWindow = getRuntimeScheduleState(weekdays, new Date("2026-10-19T18:00:00.000Z"));
assert.equal(mondayWithinWindow.active, true);
assert.equal(mondayWithinWindow.windowKey, "2026-10-19");
assert.equal(mondayWithinWindow.nextEvent.action, "stop");
assert.equal(mondayWithinWindow.nextEvent.at.toISOString(), "2026-10-19T23:00:00.000Z");

const fridayAfterClose = getRuntimeScheduleState(weekdays, new Date("2026-10-24T00:00:00.000Z"));
assert.equal(fridayAfterClose.active, false);
assert.equal(fridayAfterClose.nextEvent.at.toISOString(), "2026-10-26T13:00:00.000Z");

const springGap = getRuntimeScheduleState({
  days: [7], startTime: "02:30", endTime: "04:00", timezone: "America/New_York",
}, new Date("2026-03-08T07:00:00.000Z"));
assert.equal(springGap.active, true);
assert.equal(springGap.nextEvent.at.toISOString(), "2026-03-08T08:00:00.000Z");

const fallBackContinuous = getRuntimeScheduleState({
  days: [7], startTime: "01:30", endTime: "01:45", timezone: "America/New_York",
}, new Date("2026-11-01T06:15:00.000Z"));
assert.equal(fallBackContinuous.active, true);
assert.equal(fallBackContinuous.nextEvent.at.toISOString(), "2026-11-01T06:45:00.000Z");

console.log("runtime schedule helper tests passed");
