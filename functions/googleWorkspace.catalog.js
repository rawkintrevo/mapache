"use strict";

// Endpoints and scope presets follow Google's official Google Workspace MCP
// configuration guide: https://developers.google.com/workspace/guides/configure-mcp-servers
const {GOOGLE_SERVICE_KEYS} = require("./googleWorkspace.models");

const READ_SCOPE = Object.freeze({
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
  docs: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
  ],
  sheets: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ],
  slides: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/presentations.readonly",
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ],
  chat: [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.memberships.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.users.readstate.readonly",
  ],
  people: [
    "https://www.googleapis.com/auth/directory.readonly",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/contacts.readonly",
  ],
});

const WRITE_SCOPE = Object.freeze({
  gmail: ["https://www.googleapis.com/auth/gmail.compose"],
  drive: ["https://www.googleapis.com/auth/drive.file"],
  docs: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/documents"],
  sheets: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets"],
  slides: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/presentations"],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
  chat: ["https://www.googleapis.com/auth/chat.messages.create"],
  people: [],
});

const CATALOG = Object.freeze(GOOGLE_SERVICE_KEYS.map((key) => Object.freeze({
  key,
  displayName: key === "people" ? "People" : key[0].toUpperCase() + key.slice(1),
  serverUrl: `https://${key === "people" ? "people" : `${key}mcp`}.googleapis.com/mcp/v1`,
  readScopes: Object.freeze([...READ_SCOPE[key]]),
  writeScopes: Object.freeze([...WRITE_SCOPE[key]]),
  accessLevels: Object.freeze(WRITE_SCOPE[key].length ? ["read", "write"] : ["read"]),
  apiService: key === "calendar" ? "calendar-json.googleapis.com" : `${key}.googleapis.com`,
  mcpService: key === "people" ? "people.googleapis.com" : `${key}mcp.googleapis.com`,
})));

const CATALOG_BY_KEY = new Map(CATALOG.map((entry) => [entry.key, entry]));

function googleWorkspaceServiceCatalog() {
  return CATALOG.map((entry) => ({
    ...entry,
    readScopes: [...entry.readScopes],
    writeScopes: [...entry.writeScopes],
    accessLevels: [...entry.accessLevels],
  }));
}

function getGoogleWorkspaceService(key) {
  const entry = CATALOG_BY_KEY.get(String(key || "").trim().toLowerCase());
  return entry ? {
    ...entry,
    readScopes: [...entry.readScopes],
    writeScopes: [...entry.writeScopes],
    accessLevels: [...entry.accessLevels],
  } : null;
}

function googleWorkspaceScopeSelection(serviceKeys = [], accessLevel = "read") {
  const level = accessLevel === "write" ? "write" : "read";
  return [...new Set(serviceKeys.flatMap((key) => {
    const service = getGoogleWorkspaceService(key);
    return service ? [...service.readScopes, ...(level === "write" ? service.writeScopes : [])] : [];
  }))];
}

module.exports = {
  getGoogleWorkspaceService,
  googleWorkspaceScopeSelection,
  googleWorkspaceServiceCatalog,
};
