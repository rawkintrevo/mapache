import assert from "node:assert/strict";
import {test} from "node:test";
import {batchUpdateValues, insertDimension, registerSheetsWriteTools, updateValues} from "./sheetsWrites.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

test("registers Sheets writes only with the spreadsheet write scope", () => {
  const server = fakeServer();
  assert.equal(registerSheetsWriteTools(server, {client: {}, config: {hasGrantedScope: (_service, scope) => scope === WRITE_SCOPE}}).length, 3);
  const blocked = fakeServer();
  assert.deepEqual(registerSheetsWriteTools(blocked, {client: {}, config: {hasGrantedScope: () => false}}), []);
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
