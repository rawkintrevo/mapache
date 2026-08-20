import * as z from "zod/v4";
import {compactEvent} from "./calendar.mjs";
import {
  pathSegment,
  queryParams,
  registerJsonTool,
  requiredText,
} from "./tools.mjs";

const CALENDAR_API = "/calendar/v3";
const EVENT_FIELDS = ["summary", "description", "location", "start", "end", "attendees", "recurrence", "conferenceData", "colorId", "transparency", "visibility", "reminders"];
const EVENT_SCHEMA = z.record(z.string(), z.unknown());
const TARGET_SCHEMA = {calendarId: z.string().max(512).optional(), usePrimary: z.boolean().optional()};

export function registerCalendarWriteTools(server, {client, config}) {
  if (!config?.hasWriteScope?.("calendar")) return [];
  registerJsonTool(server, "calendar_create_event", {
    description: "Create one bounded Google Calendar event.",
    inputSchema: z.object({...TARGET_SCHEMA, event: EVENT_SCHEMA, sendUpdates: z.enum(["all", "externalOnly", "none"]).optional()}),
  }, (input) => createEvent(client, input));
  registerJsonTool(server, "calendar_update_event", {
    description: "Update one bounded Google Calendar event.",
    inputSchema: z.object({...TARGET_SCHEMA, eventId: z.string().min(1).max(512), event: EVENT_SCHEMA, etag: z.string().max(512).optional(), sendUpdates: z.enum(["all", "externalOnly", "none"]).optional()}),
  }, (input) => updateEvent(client, input));
  registerJsonTool(server, "calendar_delete_event", {
    description: "Delete one Google Calendar event by ID.",
    inputSchema: z.object({...TARGET_SCHEMA, eventId: z.string().min(1).max(512), sendUpdates: z.enum(["all", "externalOnly", "none"]).optional()}),
  }, (input) => deleteEvent(client, input));
  registerJsonTool(server, "calendar_respond_to_event", {
    description: "Respond to one Google Calendar event as the connected account.",
    inputSchema: z.object({...TARGET_SCHEMA, eventId: z.string().min(1).max(512), responseStatus: z.enum(["accepted", "declined", "tentative"]), sendUpdates: z.enum(["all", "externalOnly", "none"]).optional()}),
  }, (input) => respondToEvent(client, input));
  return ["calendar_create_event", "calendar_update_event", "calendar_delete_event", "calendar_respond_to_event"];
}

export async function createEvent(client, input = {}) {
  const calendarId = calendarTarget(input);
  const event = normalizeEvent(input.event);
  const response = await client.request(`${CALENDAR_API}/calendars/${pathSegment(calendarId, "calendarId")}/events?${queryParams({sendUpdates: input.sendUpdates || "all"})}`, {
    method: "POST",
    body: JSON.stringify(event),
  });
  return mutationResult(response);
}

export async function updateEvent(client, input = {}) {
  const calendarId = calendarTarget(input);
  const eventId = pathSegment(input.eventId, "eventId");
  const event = normalizeEvent(input.event);
  const headers = input.etag ? {"if-match": requiredText(input.etag, "etag", 512)} : undefined;
  const response = await client.request(`${CALENDAR_API}/calendars/${pathSegment(calendarId, "calendarId")}/events/${eventId}?${queryParams({sendUpdates: input.sendUpdates || "all"})}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(event),
  });
  return mutationResult(response);
}

export async function deleteEvent(client, input = {}) {
  const calendarId = calendarTarget(input);
  const eventId = requiredText(input.eventId, "eventId", 512);
  await client.request(`${CALENDAR_API}/calendars/${pathSegment(calendarId, "calendarId")}/events/${pathSegment(eventId, "eventId")}?${queryParams({sendUpdates: input.sendUpdates || "all"})}`, {method: "DELETE"});
  return {eventId, htmlLink: null, updated: null, deleted: true};
}

export async function respondToEvent(client, input = {}) {
  const calendarId = calendarTarget(input);
  const eventId = pathSegment(input.eventId, "eventId");
  const response = await client.request(`${CALENDAR_API}/calendars/${pathSegment(calendarId, "calendarId")}/events/${eventId}?${queryParams({sendUpdates: input.sendUpdates || "all"})}`, {
    method: "PATCH",
    body: JSON.stringify({attendees: [{self: true, responseStatus: input.responseStatus}]}),
  });
  return mutationResult(response);
}

function calendarTarget(input) {
  const calendarId = String(input.calendarId || "").trim();
  if (calendarId) return calendarId;
  if (input.usePrimary === true) return "primary";
  const error = new Error("An explicit calendarId or usePrimary=true is required.");
  error.code = "calendar_target_required";
  throw error;
}

function normalizeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("event is required.");
    error.code = "invalid_event";
    throw error;
  }
  const event = Object.fromEntries(EVENT_FIELDS.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  if (!event.start || !event.end || typeof event.start !== "object" || typeof event.end !== "object") {
    const error = new Error("event start and end are required.");
    error.code = "event_time_required";
    throw error;
  }
  if (JSON.stringify(event).length > 50_000) {
    const error = new Error("event payload is too large.");
    error.code = "event_too_large";
    throw error;
  }
  return event;
}

function mutationResult(event = {}) {
  return {
    eventId: event.id || null,
    htmlLink: event.htmlLink || null,
    updated: event.updated || null,
    event: compactEvent(event),
  };
}
