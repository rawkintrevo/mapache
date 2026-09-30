import assert from "node:assert/strict";
import {test} from "node:test";
import {createGoogleRestClient} from "./restClient.mjs";
import {getSpreadsheet, getValues, registerSheetsReadTools} from "./sheets.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

function recordingSheetsClient(calls) {
  return createGoogleRestClient({
    env: {GOOGLE_MCP_ACCESS_TOKEN: "test-token"},
    fetchImpl: async (url) => {
      calls.push(url);
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/values:batchGet")) {
        return Response.json({valueRanges: []});
      }
      return Response.json({spreadsheetId: "sheet-1", properties: {}, sheets: []});
    },
  });
}

test("registers Sheets metadata and values reads only with read scope", () => {
  const server = fakeServer();
  assert.deepEqual(registerSheetsReadTools(server, {client: {}, config: {hasReadScope: () => true}}), ["sheets_get_spreadsheet", "sheets_get_values"]);
  const blocked = fakeServer();
  assert.deepEqual(registerSheetsReadTools(blocked, {client: {}, config: {hasReadScope: () => false}}), []);
});

test("resolves Sheets metadata and values through the Sheets API service endpoint", async () => {
  const calls = [];
  const client = recordingSheetsClient(calls);

  await getSpreadsheet(client, {spreadsheetId: "sheet-1"});
  await getValues(client, {spreadsheetId: "sheet-1", ranges: ["Sheet1!A1"]});

  assert.equal(new URL(calls[0]).origin, "https://sheets.googleapis.com");
  assert.equal(new URL(calls[0]).pathname, "/v4/spreadsheets/sheet-1");
  assert.equal(new URL(calls[1]).origin, "https://sheets.googleapis.com");
  assert.equal(new URL(calls[1]).pathname, "/v4/spreadsheets/sheet-1/values:batchGet");
});

test("fetches explicit quoted/multiple A1 ranges and enforces cell limits", async () => {
  const calls = [];
  const result = await getValues({request: async (url) => {
    calls.push(url);
    return {valueRanges: [{range: "'Q1 Sales'!A1:B2", majorDimension: "ROWS", values: [["a", "b"], ["c", "d"]]}, {range: "Sheet2!A1", values: [["e"]]}]};
  }}, {spreadsheetId: "sheet-1", ranges: ["'Q1 Sales'!A1:B2", "Sheet2!A1"], valueRenderOption: "FORMULA", maxCells: 3});
  assert.match(calls[0], /ranges=%27Q1\+Sales%27%21A1%3AB2/);
  assert.match(calls[0], /valueRenderOption=FORMULA/);
  assert.equal(result.cellCount, 3);
  assert.equal(result.truncated, true);
});
