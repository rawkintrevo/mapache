import assert from "node:assert/strict";
import {test} from "node:test";
import {compactMessage, decodeMimeText, getMessage, registerGmailReadTools} from "./gmail.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("registers Gmail read-only tools only with the Gmail read scope", () => {
  const server = fakeServer();
  assert.equal(registerGmailReadTools(server, {client: {}, config: {hasReadScope: () => true}}).length, 5);
  assert.equal(server.tools.size, 5);
  const blocked = fakeServer();
  assert.deepEqual(registerGmailReadTools(blocked, {client: {}, config: {hasReadScope: () => false}}), []);
  assert.equal(blocked.tools.size, 0);
});

test("decodes multipart plain text and returns attachment metadata without binary data", () => {
  const result = compactMessage({
    id: "message-1",
    threadId: "thread-1",
    snippet: "hello",
    payload: {
      headers: [{name: "Subject", value: "Hello"}, {name: "X-Ignore", value: "drop"}],
      mimeType: "multipart/mixed",
      parts: [
        {mimeType: "multipart/alternative", parts: [{mimeType: "text/plain", body: {data: "SGVsbG8="}}]},
        {filename: "photo.png", mimeType: "image/png", body: {attachmentId: "att-1", size: 42, data: "should-not-return"}},
      ],
    },
  });
  assert.equal(result.plainText, "Hello");
  assert.deepEqual(result.headers, {subject: "Hello"});
  assert.deepEqual(result.attachments, [{attachmentId: "att-1", filename: "photo.png", mimeType: "image/png", size: 42}]);
  assert.equal(JSON.stringify(result).includes("should-not-return"), false);
});

test("handles missing and malformed MIME text safely", () => {
  const state = {mimeDecodeError: false};
  assert.equal(decodeMimeText("not-base64?", state), null);
  assert.equal(state.mimeDecodeError, true);
  assert.deepEqual(compactMessage({payload: {mimeType: "text/plain", body: {}}}).plainText, null);
});

test("gets one message through the bounded REST client", async () => {
  const calls = [];
  const result = await getMessage({request: async (url) => {
    calls.push(url);
    return {id: "message-1", payload: {headers: [], mimeType: "text/plain", body: {data: "V29ybGQ="}}};
  }}, {messageId: "message-1"});
  assert.match(calls[0], /messages\/message-1/);
  assert.equal(result.message.plainText, "World");
});
