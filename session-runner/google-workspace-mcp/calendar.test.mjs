import assert from "node:assert/strict";
import {test} from "node:test";
import {registerCalendarReadTools, listEvents, compactEvent} from "./calendar.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

function readConfig() {
  return {hasReadScope: () => true};
}

test("registers the five bounded Calendar read tools only when read scope is present", () => {
  const server = fakeServer();
  assert.deepEqual(registerCalendarReadTools(server, {client: {}, config: readConfig()}), [
    "calendar_list_calendars", "calendar_list_events", "calendar_get_event", "calendar_search_events", "calendar_query_freebusy",
  ]);
  assert.deepEqual([...server.tools.keys()], [
    "calendar_list_calendars", "calendar_list_events", "calendar_get_event", "calendar_search_events", "calendar_query_freebusy",
  ]);
  const blocked = fakeServer();
  assert.deepEqual(registerCalendarReadTools(blocked, {client: {}, config: {hasReadScope: () => false}}), []);
  assert.equal(blocked.tools.size, 0);
});

test("lists events with primary calendar, explicit range, pagination, and compact all-day fields", async () => {
  const calls = [];
  const client = {
    paginate: async (requestPage, options) => {
      const page = await requestPage({});
      calls.push({page, options});
      return {items: [{id: "event-1", summary: "All day", start: {date: "2026-08-20"}, end: {date: "2026-08-21"}, privateField: "drop"}], pages: 1, truncated: false, nextPageToken: null};
    },
    request: async (url) => ({items: [], url}),
  };
  const result = await listEvents(client, {start: "2026-08-20T00:00:00Z", end: "2026-08-21T00:00:00Z"});
  assert.deepEqual(result.events, [{id: "event-1", summary: "All day", start: {date: "2026-08-20"}, end: {date: "2026-08-21"}}]);
  assert.match(calls[0].page.url, /calendars\/primary\/events/);
  assert.match(calls[0].page.url, /timeMin=2026-08-20T00%3A00%3A00Z/);
});

test("rejects missing or reversed Calendar ranges and preserves time zones", async () => {
  await assert.rejects(listEvents({paginate: async () => ({})}, {}), (error) => error.code === "invalid_start");
  await assert.rejects(listEvents({paginate: async () => ({})}, {start: "2026-08-21T00:00:00Z", end: "2026-08-20T00:00:00Z"}), (error) => error.code === "invalid_time_range");
  assert.deepEqual(compactEvent({id: "x", start: {dateTime: "2026-08-20T01:00:00-05:00", timeZone: "America/Chicago"}, ignored: true}), {
    id: "x",
    start: {dateTime: "2026-08-20T01:00:00-05:00", timeZone: "America/Chicago"},
  });
});
