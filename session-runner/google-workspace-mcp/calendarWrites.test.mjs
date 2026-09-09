import assert from "node:assert/strict";
import {test} from "node:test";
import {registerCalendarWriteTools, createEvent, respondToEvent} from "./calendarWrites.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("registers Calendar mutation tools only with write scope", () => {
  const server = fakeServer();
  assert.equal(registerCalendarWriteTools(server, {client: {}, config: {hasWriteScope: () => true}}).length, 4);
  assert.equal(server.tools.size, 4);
  const readOnly = fakeServer();
  assert.deepEqual(registerCalendarWriteTools(readOnly, {client: {}, config: {hasWriteScope: () => false}}), []);
  assert.equal(readOnly.tools.size, 0);
});

test("creates an explicit primary-calendar event while preserving event fields", async () => {
  const calls = [];
  const client = {request: async (url, options) => {
    calls.push({url, options});
    return {id: "event-1", htmlLink: "https://calendar.google.com/event-1", updated: "2026-08-20T01:00:00Z", start: options.body && JSON.parse(options.body).start, end: JSON.parse(options.body).end};
  }};
  const result = await createEvent(client, {usePrimary: true, event: {
    summary: "Disposable event",
    start: {dateTime: "2026-08-20T01:00:00-05:00", timeZone: "America/Chicago"},
    end: {dateTime: "2026-08-20T02:00:00-05:00", timeZone: "America/Chicago"},
    recurrence: ["RRULE:FREQ=DAILY;COUNT=1"],
    attendees: [{email: "guest@example.com"}],
    conferenceData: {createRequest: {requestId: "request-1"}},
  }});
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].url, /calendars\/primary\/events/);
  assert.equal(JSON.parse(calls[0].options.body).conferenceData.createRequest.requestId, "request-1");
  assert.equal(result.eventId, "event-1");
});

test("requires an explicit target and responds through a bounded attendee patch", async () => {
  await assert.rejects(createEvent({request: async () => ({})}, {event: {start: {date: "2026-08-20"}, end: {date: "2026-08-21"}}}), (error) => error.code === "calendar_target_required");
  const calls = [];
  const result = await respondToEvent({request: async (url, options) => {
    calls.push({url, options});
    return {id: "event-2", updated: "now"};
  }}, {calendarId: "calendar-1", eventId: "event-2", responseStatus: "accepted"});
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), {attendees: [{self: true, responseStatus: "accepted"}]});
  assert.equal(result.eventId, "event-2");
});
