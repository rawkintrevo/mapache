import assert from "node:assert/strict";
import {test} from "node:test";
import {getValues, registerSheetsReadTools} from "./sheets.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("registers Sheets metadata and values reads only with read scope", () => {
  const server = fakeServer();
  assert.deepEqual(registerSheetsReadTools(server, {client: {}, config: {hasReadScope: () => true}}), ["sheets_get_spreadsheet", "sheets_get_values"]);
  const blocked = fakeServer();
  assert.deepEqual(registerSheetsReadTools(blocked, {client: {}, config: {hasReadScope: () => false}}), []);
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
