"use strict";

const assert = require("assert");
const {
  getGoogleWorkspaceService,
  googleWorkspaceScopeSelection,
  googleWorkspaceServiceCatalog,
} = require("./googleWorkspace.catalog");

const catalog = googleWorkspaceServiceCatalog();
assert.deepStrictEqual(catalog.map((entry) => entry.key), ["gmail", "drive", "docs", "sheets", "slides", "calendar", "chat", "people"]);
assert.strictEqual(new Set(catalog.map((entry) => entry.serverUrl)).size, catalog.length);
assert.ok(catalog.every((entry) => entry.readScopes.length && entry.serverUrl.startsWith("https://")));
assert.strictEqual(getGoogleWorkspaceService("GMAIL").serverUrl, "https://gmailmcp.googleapis.com/mcp/v1");
assert.deepStrictEqual(googleWorkspaceScopeSelection(["gmail"], "read"), [
  "https://www.googleapis.com/auth/gmail.readonly",
]);
assert.deepStrictEqual(googleWorkspaceScopeSelection(["gmail"], "write"), [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
]);
assert.deepStrictEqual(googleWorkspaceScopeSelection(["calendar"], "write"), [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.events",
]);
assert.deepStrictEqual(getGoogleWorkspaceService("calendar").accessLevels, ["read", "write"]);
assert.deepStrictEqual(googleWorkspaceScopeSelection(["unknown", "gmail"], "read"), [
  "https://www.googleapis.com/auth/gmail.readonly",
]);
assert.strictEqual(getGoogleWorkspaceService("unknown"), null);

const serialized = JSON.stringify(catalog);
assert.strictEqual(/clientSecret|accessToken|refreshToken/.test(serialized), false);
console.log("google workspace catalog tests passed");
