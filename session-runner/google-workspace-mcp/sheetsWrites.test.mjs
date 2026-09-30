import assert from "node:assert/strict";
import {test} from "node:test";
import {createGoogleRestClient} from "./restClient.mjs";
import {batchUpdateValues, createSpreadsheet, insertDimension, registerSheetsWriteTools, updateValues} from "./sheetsWrites.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function recordingSheetsClient(calls) {
  return createGoogleRestClient({
    env: {GOOGLE_MCP_ACCESS_TOKEN: "test-token"},
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({totalUpdatedCells: 2, replies: [{}]});
    },
  });
}

test("registers Sheets writes only with the spreadsheet write scope", () => {
  const server = fakeServer();
  assert.equal(registerSheetsWriteTools(server, {client: {}, config: {hasGrantedScope: (_service, scope) => scope === WRITE_SCOPE}}).length, 4);
  assert.ok(server.tools.has("sheets_create_spreadsheet"));
  const blocked = fakeServer();
  assert.deepEqual(registerSheetsWriteTools(blocked, {client: {}, config: {hasGrantedScope: () => false}}), []);
});

test("creates a named spreadsheet through the Sheets REST endpoint", async () => {
  const calls = [];
  const client = createGoogleRestClient({
    env: {GOOGLE_MCP_ACCESS_TOKEN: "test-token"},
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return Response.json({spreadsheetId: "sheet-created", properties: {title: "Planning"}});
    },
  });

  const result = await createSpreadsheet(client, {title: "Planning"});
  assert.deepEqual(result, {
    spreadsheetId: "sheet-created",
    url: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
    title: "Planning",
  });
  assert.equal(calls[0].url, "https://sheets.googleapis.com/v4/spreadsheets");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {properties: {title: "Planning"}});
});

test("resolves Sheets value writes and dimension insertion through the Sheets API service endpoint", async () => {
  const calls = [];
  const client = recordingSheetsClient(calls);

  await updateValues(client, {spreadsheetId: "sheet-1", range: "Sheet1!A1", values: [[1]]});
  await batchUpdateValues(client, {spreadsheetId: "sheet-1", data: [{range: "Sheet1!A1", values: [[1]]}]});
  await insertDimension(client, {spreadsheetId: "sheet-1", sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2});

  assert.deepEqual(calls.map((url) => ({origin: new URL(url).origin, pathname: new URL(url).pathname})), [
    {origin: "https://sheets.googleapis.com", pathname: "/v4/spreadsheets/sheet-1/values/Sheet1!A1"},
    {origin: "https://sheets.googleapis.com", pathname: "/v4/spreadsheets/sheet-1/values:batchUpdate"},
    {origin: "https://sheets.googleapis.com", pathname: "/v4/spreadsheets/sheet-1:batchUpdate"},
  ]);
});

test("updates RAW and USER_ENTERED values with explicit ranges", async () => {
  const calls = [];
  await updateValues({request: async (url, options) => {
    calls.push({url, options});
    return {updatedRange: "Sheet1!A1:B1", updatedCells: 2};
  }}, {spreadsheetId: "sheet-1", range: "Sheet1!A1:B1", values: [["=1+1", 2]], valueInputOption: "USER_ENTERED"});
  assert.match(calls[0].url, /valueInputOption=USER_ENTERED/);
  assert.equal(JSON.parse(calls[0].options.body).values[0][0], "=1+1");
});

test("batches ranges, bounds values, and inserts dimensions", async () => {
  const calls = [];
  const client = {request: async (url, options) => {
    calls.push({url, options});
    return {totalUpdatedCells: 2, replies: [{}]};
  }};
  const result = await batchUpdateValues(client, {spreadsheetId: "sheet-1", data: [{range: "Sheet1!A1", values: [[1]]}, {range: "Sheet1!B1", values: [[2]]}]});
  assert.equal(result.totalUpdatedCells, 2);
  await insertDimension(client, {spreadsheetId: "sheet-1", sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2});
  assert.deepEqual(JSON.parse(calls[1].options.body).requests[0].insertDimension.range, {sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2});
  await assert.rejects(insertDimension(client, {spreadsheetId: "sheet-1", sheetId: 0, dimension: "ROWS", startIndex: 2, endIndex: 2}), (error) => error.code === "invalid_dimension_range");
});
