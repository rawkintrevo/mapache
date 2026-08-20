import assert from "node:assert/strict";
import {test} from "node:test";
import {buildFileQuery, escapeDriveQueryValue, registerDriveReadTools, searchFiles} from "./drive.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("registers Drive discovery tools only with drive read scope", () => {
  const server = fakeServer();
  assert.equal(registerDriveReadTools(server, {client: {}, config: {hasReadScope: () => true}}).length, 4);
  const blocked = fakeServer();
  assert.deepEqual(registerDriveReadTools(blocked, {client: {}, config: {hasReadScope: () => false}}), []);
  assert.equal(blocked.tools.size, 0);
});

test("escapes Drive search values and includes shared-drive flags and projections", async () => {
  assert.equal(escapeDriveQueryValue("O'Reilly\\book"), "O\\'Reilly\\\\book");
  assert.match(buildFileQuery({nameContains: "O'Reilly", mimeType: "application/pdf"}), /name contains 'O\\'Reilly'/);
  const calls = [];
  const result = await searchFiles({paginate: async (requestPage) => {
    const page = await requestPage({});
    calls.push(page);
    return {items: [{id: "file-1", name: "Report", mimeType: "application/pdf", modifiedTime: "now"}], pages: 1, truncated: false, nextPageToken: null};
  }, request: async (url) => ({url})}, {nameContains: "Report", driveId: "shared-1", includeAllDrives: true});
  assert.equal(result.files[0].id, "file-1");
  assert.match(calls[0].url, /corpora=drive/);
  assert.match(calls[0].url, /driveId=shared-1/);
  assert.match(calls[0].url, /fields=/);
  assert.match(calls[0].url, /includeItemsFromAllDrives=true/);
});
