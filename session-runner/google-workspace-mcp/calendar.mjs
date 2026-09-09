import * as z from "zod/v4";
import {
  boundedItemLimit,
  boundedPageSize,
  pathSegment,
  queryParams,
  registerJsonTool,
  requiredText,
  requiredTimeRange,
} from "./tools.mjs";

const CALENDAR_API = "/calendar/v3";
const READ_SCOPED = ["calendar_list_calendars", "calendar_list_events", "calendar_get_event", "calendar_search_events", "calendar_query_freebusy"];

const pageSchema = z.number().int().min(1).max(100).optional();
const rangeSchema = {
  start: z.string().min(1).max(80),
  end: z.string().min(1).max(80),
};

export function registerCalendarReadTools(server, {client, config}) {
  if (!config?.hasReadScope?.("calendar")) return [];

  registerJsonTool(server, "calendar_list_calendars", {
    description: "List calendars visible to the connected Google account.",
    inputSchema: z.object({pageSize: pageSchema, maxItems: z.number().int().min(1).max(500).optional()}),
  }, (input) => listCalendars(client, input));
  registerJsonTool(server, "calendar_list_events", {
    description: "List events in an explicit time range.",
    inputSchema: z.object({calendarId: z.string().max(512).optional(), ...rangeSchema, pageSize: pageSchema, maxItems: z.number().int().min(1).max(500).optional()}),
  }, (input) => listEvents(client, input));
  registerJsonTool(server, "calendar_get_event", {
    description: "Get one Calendar event by ID.",
    inputSchema: z.object({calendarId: z.string().max(512).optional(), eventId: z.string().min(1).max(512)}),
  }, (input) => getEvent(client, input));
  registerJsonTool(server, "calendar_search_events", {
    description: "Search Calendar events within an explicit time range.",
    inputSchema: z.object({calendarId: z.string().max(512).optional(), query: z.string().min(1).max(256), ...rangeSchema, pageSize: pageSchema, maxItems: z.number().int().min(1).max(500).optional()}),
  }, (input) => searchEvents(client, input));
  registerJsonTool(server, "calendar_query_freebusy", {
    description: "Query Calendar free/busy information for an explicit time range.",
    inputSchema: z.object({calendarIds: z.array(z.string().min(1).max(512)).min(1).max(20).optional(), ...rangeSchema}),
  }, (input) => queryFreebusy(client, input));
  return READ_SCOPED;
}

export async function listCalendars(client, input = {}) {
  const result = await client.paginate((params) => client.request(`${CALENDAR_API}/users/me/calendarList?${queryParams({
    ...params,
    maxResults: boundedPageSize(input.pageSize),
    showDeleted: false,
  })}`), {maxItems: boundedItemLimit(input.maxItems)});
  return {calendars: result.items.map(compactCalendar), pages: result.pages, truncated: result.truncated, nextPageToken: result.nextPageToken};
}

export async function listEvents(client, input = {}) {
  const range = requiredTimeRange(input.start, input.end);
  const result = await paginateEvents(client, input, range, {});
  return {events: result.items.map(compactEvent), pages: result.pages, truncated: result.truncated, nextPageToken: result.nextPageToken};
}

export async function searchEvents(client, input = {}) {
  const range = requiredTimeRange(input.start, input.end);
  const result = await paginateEvents(client, input, range, {q: requiredText(input.query, "query", 256)});
  return {events: result.items.map(compactEvent), pages: result.pages, truncated: result.truncated, nextPageToken: result.nextPageToken};
}

export async function getEvent(client, input = {}) {
  const calendarId = pathSegment(input.calendarId || "primary", "calendarId");
  const eventId = pathSegment(input.eventId, "eventId");
  return {event: compactEvent(await client.request(`${CALENDAR_API}/calendars/${calendarId}/events/${eventId}`))};
}

export async function queryFreebusy(client, input = {}) {
  const {timeMin, timeMax} = requiredTimeRange(input.start, input.end);
  const calendarIds = (input.calendarIds?.length ? input.calendarIds : ["primary"]).map((id) => ({id: requiredText(id, "calendarId", 512)}));
  const result = await client.request(`${CALENDAR_API}/freeBusy`, {
    method: "POST",
    body: JSON.stringify({timeMin, timeMax, items: calendarIds}),
  });
  return {
    timeMin,
    timeMax,
    calendars: Object.fromEntries(Object.entries(result?.calendars || {}).map(([id, value]) => [id, {
      errors: Array.isArray(value?.errors) ? value.errors.map((error) => ({domain: error.domain || null, reason: error.reason || null})) : [],
      busy: Array.isArray(value?.busy) ? value.busy.map((range) => ({start: range.start || null, end: range.end || null})) : [],
    }])),
  };
}

async function paginateEvents(client, input, range, extra) {
  return client.paginate((params) => client.request(`${CALENDAR_API}/calendars/${pathSegment(input.calendarId || "primary", "calendarId")}/events?${queryParams({
    ...params,
    ...range,
    ...extra,
    maxResults: boundedPageSize(input.pageSize),
    singleEvents: true,
    orderBy: "startTime",
  })}`), {maxItems: boundedItemLimit(input.maxItems)});
}

function compactCalendar(calendar = {}) {
  return pick(calendar, ["id", "summary", "description", "summaryOverride", "timeZone", "primary", "accessRole", "selected", "deleted"]);
}

export function compactEvent(event = {}) {
  return pick(event, ["id", "status", "htmlLink", "summary", "description", "location", "start", "end", "recurrence", "attendees", "organizer", "creator", "updated", "created", "etag"]);
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
