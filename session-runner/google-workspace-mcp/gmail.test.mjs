import assert from "node:assert/strict";
import {test} from "node:test";
import {compactMessage, decodeMimeText, getMessage, listDrafts, registerGmailReadTools, searchThreads} from "./gmail.mjs";

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

test("searches Gmail thread responses without discarding their threads field", async () => {
  const calls = [];
  const result = await searchThreads({
    paginate: async (requestPage, options) => {
      calls.push(options);
      const page = await requestPage({pageToken: "next-page"});
      return {
        items: page[options.itemsKey],
        pages: 1,
        truncated: false,
        nextPageToken: null,
      };
    },
    request: async (url) => {
      calls.push(url);
      return {threads: [{id: "thread-1", historyId: "history-1"}]};
    },
  }, {query: "from:person@example.com", pageSize: 25, maxItems: 25});

  assert.deepEqual(calls[0], {itemsKey: "threads", maxItems: 25});
  assert.match(calls[1], /q=from%3Aperson%40example.com/);
  assert.match(calls[1], /maxResults=25/);
  assert.match(calls[1], /pageToken=next-page/);
  assert.deepEqual(result.threads, [{id: "thread-1", snippet: null, historyId: "history-1"}]);
});

test("lists Gmail draft responses without discarding their drafts field", async () => {
  const result = await listDrafts({
    paginate: async (_requestPage, options) => ({
      items: options.itemsKey === "drafts" ? [{id: "draft-1", message: {id: "message-1"}}] : [],
      pages: 1,
      truncated: false,
      nextPageToken: null,
    }),
  }, {maxItems: 10});

  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].id, "draft-1");
  assert.equal(result.drafts[0].message.id, "message-1");
});
