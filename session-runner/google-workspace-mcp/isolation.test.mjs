import assert from "node:assert/strict";
import {test} from "node:test";
import {createGoogleWorkspaceConfig} from "./config.mjs";
import {registerCalendarReadTools} from "./calendar.mjs";
import {registerCalendarWriteTools} from "./calendarWrites.mjs";
import {registerGmailReadTools} from "./gmail.mjs";
import {registerGmailWriteTools} from "./gmailWrites.mjs";
import {registerDriveReadTools} from "./drive.mjs";
import {registerDriveWriteTools} from "./driveWrites.mjs";
import {registerDocsReadTools} from "./docs.mjs";
import {registerDocsWriteTools} from "./docsWrites.mjs";
import {registerSheetsReadTools} from "./sheets.mjs";
import {registerSheetsWriteTools} from "./sheetsWrites.mjs";
import {registerSlidesReadTools} from "./slides.mjs";
import {registerSlidesWriteTools} from "./slidesWrites.mjs";
import {safeToolMessage} from "./tools.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("service config is isolated and never accepts token values", () => {
  const configA = createGoogleWorkspaceConfig({env: {GOOGLE_MCP_ENABLED_SERVICES: '["gmail"]', GOOGLE_MCP_GRANTED_SCOPES: '["https://www.googleapis.com/auth/gmail.readonly"]', GOOGLE_MCP_ACCESS_TOKEN: "token-a"}});
  const configB = createGoogleWorkspaceConfig({env: {GOOGLE_MCP_ENABLED_SERVICES: '["drive"]', GOOGLE_MCP_GRANTED_SCOPES: '["https://www.googleapis.com/auth/drive.readonly"]', GOOGLE_MCP_ACCESS_TOKEN: "token-b"}});
  assert.deepEqual(configA.enabledServices, ["gmail"]);
  assert.deepEqual(configB.enabledServices, ["drive"]);
  assert.doesNotMatch(JSON.stringify(configA), /token-a/);
  assert.doesNotMatch(JSON.stringify(configB), /token-b/);
});

test("read-only and write catalogs are enforced for every supported product", () => {
  const readServer = fakeServer();
  const readConfig = {hasReadScope: () => true, hasWriteScope: () => false, hasGrantedScope: () => false};
  registerCalendarReadTools(readServer, {client: {}, config: readConfig});
  registerGmailReadTools(readServer, {client: {}, config: readConfig});
  registerDriveReadTools(readServer, {client: {}, config: readConfig});
  registerDocsReadTools(readServer, {client: {}, config: readConfig});
  registerSheetsReadTools(readServer, {client: {}, config: readConfig});
  registerSlidesReadTools(readServer, {client: {}, config: readConfig});
  registerCalendarWriteTools(readServer, {client: {}, config: readConfig});
  registerGmailWriteTools(readServer, {client: {}, config: readConfig});
  registerDriveWriteTools(readServer, {client: {}, config: readConfig});
  registerDocsWriteTools(readServer, {client: {}, config: readConfig});
  registerSheetsWriteTools(readServer, {client: {}, config: readConfig});
  registerSlidesWriteTools(readServer, {client: {}, config: readConfig});
  assert.equal([...readServer.tools.keys()].some((name) => /create|update|delete|write|modify|send|insert|batch/.test(name)), false);

  const writeServer = fakeServer();
  const writeConfig = {hasReadScope: () => true, hasWriteScope: () => true, hasGrantedScope: () => true};
  registerCalendarWriteTools(writeServer, {client: {}, config: writeConfig});
  registerGmailWriteTools(writeServer, {client: {}, config: writeConfig});
  registerDriveWriteTools(writeServer, {client: {}, config: writeConfig});
  registerDocsWriteTools(writeServer, {client: {}, config: writeConfig});
  registerSheetsWriteTools(writeServer, {client: {}, config: writeConfig});
  registerSlidesWriteTools(writeServer, {client: {}, config: writeConfig});
  assert.ok(writeServer.tools.size > 0);
});

test("tool error text redacts bearer-shaped secrets", () => {
  assert.doesNotMatch(safeToolMessage(new Error("provider said Bearer super-secret-token")), /super-secret-token/);
});
