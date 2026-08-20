import assert from "node:assert/strict";
import {test} from "node:test";
import {
  createGoogleWorkspaceConfig,
  GoogleWorkspaceConfigError,
  hasReadScope,
  hasWriteScope,
  isServiceEnabled,
  parseEnabledServices,
  parseGrantedScopes,
} from "./config.mjs";

const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_WRITE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

test("parses empty, JSON, CSV, and duplicate service configuration", () => {
  assert.deepEqual(parseEnabledServices(""), []);
  assert.deepEqual(parseEnabledServices('["gmail", "drive", "gmail"]'), ["gmail", "drive"]);
  assert.deepEqual(parseEnabledServices("gmail, drive, gmail"), ["gmail", "drive"]);
});

test("rejects unsupported service keys including Chat and People", () => {
  for (const key of ["chat", "people", "unknown"]) {
    assert.throws(() => parseEnabledServices(JSON.stringify([key])), (error) => {
      assert.ok(error instanceof GoogleWorkspaceConfigError);
      return error.code === "google_service_unsupported";
    });
  }
});

test("parses and validates granted scopes without accepting token values", () => {
  assert.deepEqual(parseGrantedScopes(JSON.stringify(["openid", GMAIL_READ, GMAIL_READ])), ["openid", GMAIL_READ]);
  assert.throws(() => parseGrantedScopes(JSON.stringify(["access-token-value"])), (error) => error.code === "google_granted_scope_invalid");
  assert.throws(() => parseGrantedScopes(JSON.stringify(["https://evil.example/token"])), (error) => error.code === "google_granted_scope_invalid");
});

test("exposes enabled/read/write scope helpers", () => {
  const config = createGoogleWorkspaceConfig({env: {
    GOOGLE_MCP_ENABLED_SERVICES: '["gmail", "drive"]',
    GOOGLE_MCP_GRANTED_SCOPES: JSON.stringify([GMAIL_READ, GMAIL_WRITE, GMAIL_MODIFY]),
  }});
  assert.equal(isServiceEnabled(config, "gmail"), true);
  assert.equal(config.isServiceEnabled("drive"), true);
  assert.equal(hasReadScope(config, "gmail"), true);
  assert.equal(config.hasReadScope("gmail"), true);
  assert.equal(hasWriteScope(config, "gmail"), true);
  assert.equal(config.hasWriteScope("gmail"), true);
  assert.equal(config.hasReadScope("drive"), false);
  assert.equal(config.hasWriteScope("drive"), false);
  assert.equal(config.isServiceEnabled("people"), false);
});
