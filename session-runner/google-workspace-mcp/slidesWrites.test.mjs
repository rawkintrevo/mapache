import assert from "node:assert/strict";
import {test} from "node:test";
import {batchUpdate, normalizeRequests, registerSlidesWriteTools} from "./slidesWrites.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

const WRITE_SCOPE = "https://www.googleapis.com/auth/presentations";

test("registers Slides mutation support only with presentation write scope", () => {
  const server = fakeServer();
  assert.deepEqual(registerSlidesWriteTools(server, {client: {}, config: {hasGrantedScope: (_service, scope) => scope === WRITE_SCOPE}}), ["slides_batch_update"]);
  const blocked = fakeServer();
  assert.deepEqual(registerSlidesWriteTools(blocked, {client: {}, config: {hasGrantedScope: () => false}}), []);
});

test("allows all bounded request types and rejects unknown ones", () => {
  const requests = normalizeRequests([
    {createSlide: {insertionIndex: 1}},
    {deleteObject: {objectId: "shape-1"}},
    {insertText: {objectId: "shape-1", text: "Hello"}},
    {deleteText: {objectId: "shape-1", textRange: {type: "FIXED_RANGE", startIndex: 0, endIndex: 2}}},
    {replaceAllText: {containsText: {text: "old"}, replaceText: "new"}},
  ]);
  assert.equal(requests.length, 5);
  assert.throws(() => normalizeRequests([{updatePageProperties: {}}]), (error) => error.code === "unsupported_presentation_request");
});

test("returns created object IDs and write metadata", async () => {
  const result = await batchUpdate({request: async (_url, options) => {
    assert.equal(options.method, "POST");
    return {presentationId: "deck-1", replies: [{createSlide: {objectId: "slide-new"}}], writeControl: {requiredRevisionId: "rev-1"}};
  }}, {presentationId: "deck-1", requests: [{createSlide: {}}]});
  assert.deepEqual(result, {presentationId: "deck-1", createdObjectIds: ["slide-new"], writeControl: {requiredRevisionId: "rev-1"}});
});
