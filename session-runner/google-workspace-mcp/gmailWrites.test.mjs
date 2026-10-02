import assert from "node:assert/strict";
import {test} from "node:test";
import {archiveMessage, archiveThread, createDraft, encodeRfc2822, modifyLabels, permanentlyDelete, registerGmailWriteTools} from "./gmailWrites.mjs";
import {createGoogleWorkspaceConfig} from "./config.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("gates drafts and labels independently by compose and modify scopes", () => {
  const server = fakeServer();
  const scopes = new Set([
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
  ]);
  assert.equal(registerGmailWriteTools(server, {client: {}, config: {hasGrantedScope: (_service, scope) => scopes.has(scope)}}).length, 8);
  const readOnly = fakeServer();
  assert.deepEqual(registerGmailWriteTools(readOnly, {client: {}, config: {hasGrantedScope: () => false}}), []);
  const composeOnly = fakeServer();
  assert.deepEqual(registerGmailWriteTools(composeOnly, {client: {}, config: {hasGrantedScope: (_service, scope) => scope.endsWith("gmail.compose")}}), ["gmail_create_draft", "gmail_update_draft"]);
});

test("encodes RFC 2822 drafts as URL-safe base64 without sending", async () => {
  const decoded = Buffer.from(encodeRfc2822({to: ["to@example.com"], subject: "Re: Hi", body: "Hello", inReplyTo: "<old@example.com>"}), "base64url").toString("utf8");
  assert.match(decoded, /To: to@example.com/);
  assert.match(decoded, /In-Reply-To: <old@example.com>/);
  assert.match(decoded, /\r\n\r\nHello$/);
  const calls = [];
  const result = await createDraft({request: async (url, options) => {
    calls.push({url, options});
    return {id: "draft-1", message: {id: "message-1", threadId: "thread-1"}};
  }}, {draft: {to: ["to@example.com"], subject: "Hi", body: "Hello"}});
  assert.equal(calls[0].options.method, "POST");
  assert.equal(JSON.parse(calls[0].options.body).message.raw.includes("+"), false);
  assert.equal(result.id, "draft-1");
});

test("labels messages and threads with explicit IDs", async () => {
  const calls = [];
  const result = await modifyLabels({request: async (url, options) => {
    calls.push({url, options});
    return {id: "thread-1"};
  }}, "thread", {threadId: "thread-1", labelIds: ["STARRED", "STARRED"]}, "addLabelIds");
  assert.match(calls[0].url, /threads\/thread-1\/modify/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {addLabelIds: ["STARRED"]});
  assert.equal(result.id, "thread-1");
});

test("archive helpers remove only the INBOX label for messages and threads", async () => {
  const calls = [];
  const client = {request: async (url, options) => {
    calls.push({url, options});
    return {id: "provider-id"};
  }};
  await archiveMessage(client, {messageId: "message-1"});
  await archiveThread(client, {threadId: "thread-1"});
  assert.deepEqual(calls.map(({url, options}) => ({url, method: options.method, body: JSON.parse(options.body)})), [
    {url: "/gmail/v1/users/me/messages/message-1/modify", method: "POST", body: {removeLabelIds: ["INBOX"]}},
    {url: "/gmail/v1/users/me/threads/thread-1/modify", method: "POST", body: {removeLabelIds: ["INBOX"]}},
  ]);
});

test("permanent-delete tools require both the opt-in and full Gmail scope", async () => {
  const fullScope = "https://mail.google.com/";
  const withoutOptIn = fakeServer();
  const withoutOptInConfig = createGoogleWorkspaceConfig({env: {
    GOOGLE_MCP_ENABLED_SERVICES: '["gmail"]',
    GOOGLE_MCP_GRANTED_SCOPES: JSON.stringify([fullScope]),
  }});
  assert.equal(registerGmailWriteTools(withoutOptIn, {client: {}, config: withoutOptInConfig}).includes("gmail_permanently_delete_message"), false);

  const optedIn = fakeServer();
  const optedInConfig = createGoogleWorkspaceConfig({env: {
    GOOGLE_MCP_ENABLED_SERVICES: '["gmail"]',
    GOOGLE_MCP_GRANTED_SCOPES: JSON.stringify([fullScope]),
    GOOGLE_MCP_GMAIL_PERMANENT_DELETE_ENABLED: "true",
  }});
  assert.equal(registerGmailWriteTools(optedIn, {client: {}, config: optedInConfig}).includes("gmail_permanently_delete_message"), true);

  const calls = [];
  const result = await permanentlyDelete({request: async (url, options) => {
    calls.push({url, options});
    return null;
  }}, "message", {messageId: "message/one"});
  assert.deepEqual(result, {type: "message", id: "message/one", permanentlyDeleted: true});
  assert.deepEqual(calls, [{url: "/gmail/v1/users/me/messages/message%2Fone", options: {method: "DELETE"}}]);
});
