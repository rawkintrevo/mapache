import assert from "node:assert/strict";
import {test} from "node:test";
import {createDraft, encodeRfc2822, modifyLabels, registerGmailWriteTools} from "./gmailWrites.mjs";

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
  assert.equal(registerGmailWriteTools(server, {client: {}, config: {hasGrantedScope: (_service, scope) => scopes.has(scope)}}).length, 6);
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
