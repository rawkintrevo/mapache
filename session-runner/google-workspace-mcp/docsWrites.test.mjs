import assert from "node:assert/strict";
import {test} from "node:test";
import {batchUpdate, normalizeRequests, registerDocsWriteTools} from "./docsWrites.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("registers Docs batch update only with write scope", () => {
  const server = fakeServer();
  assert.deepEqual(registerDocsWriteTools(server, {client: {}, config: {hasWriteScope: () => true}}), ["docs_batch_update"]);
  const blocked = fakeServer();
  assert.deepEqual(registerDocsWriteTools(blocked, {client: {}, config: {hasWriteScope: () => false}}), []);
});

test("allows bounded insert, delete, and replace requests", () => {
  assert.deepEqual(normalizeRequests([
    {insertText: {location: {index: 1, tabId: "tab-1"}, text: "Hello"}},
    {deleteContentRange: {range: {startIndex: 1, endIndex: 2}}},
    {replaceAllText: {containsText: {text: "old", matchCase: false}, replaceText: "new"}},
  ]), [
    {insertText: {location: {index: 1, tabId: "tab-1"}, text: "Hello"}},
    {deleteContentRange: {range: {startIndex: 1, endIndex: 2}}},
    {replaceAllText: {containsText: {text: "old", matchCase: false}, replaceText: "new"}},
  ]);
  assert.throws(() => normalizeRequests([{createParagraphBullets: {}}]), (error) => error.code === "unsupported_document_request");
  assert.throws(() => normalizeRequests([{insertText: {location: {index: 0}, text: "x"}}]), (error) => error.code === "invalid_document_index");
});

test("sends required revision control and returns safe write metadata", async () => {
  const calls = [];
  const result = await batchUpdate({request: async (url, options) => {
    calls.push({url, options});
    return {documentId: "doc-1", writeControl: {targetRevisionId: "rev-2"}, replies: [{}]};
  }}, {documentId: "doc-1", requiredRevisionId: "rev-1", requests: [{insertText: {location: {index: 1}, text: "x"}}]});
  assert.match(calls[0].url, /documents\/doc-1:batchUpdate/);
  assert.deepEqual(JSON.parse(calls[0].options.body).writeControl, {requiredRevisionId: "rev-1"});
  assert.equal(result.writeControl.targetRevisionId, "rev-2");
});
