import * as z from "zod/v4";
import {boundedItemLimit, pathSegment, queryParams, registerJsonTool, requiredText} from "./tools.mjs";

const SHEETS_API = "/sheets/v4";
const VALUE_RENDER_OPTIONS = ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"];
const DATE_RENDER_OPTIONS = ["SERIAL_NUMBER", "FORMATTED_STRING"];

export function registerSheetsReadTools(server, {client, config}) {
  if (!config?.hasReadScope?.("sheets")) return [];
  registerJsonTool(server, "sheets_get_spreadsheet", {
    description: "Read bounded Google Sheets spreadsheet metadata.",
    inputSchema: z.object({spreadsheetId: z.string().min(1).max(512)}),
  }, (input) => getSpreadsheet(client, input));
  registerJsonTool(server, "sheets_get_values", {
    description: "Read bounded values from explicit A1 ranges.",
    inputSchema: z.object({spreadsheetId: z.string().min(1).max(512), ranges: z.array(z.string().min(1).max(512)).min(1).max(20), valueRenderOption: z.enum(VALUE_RENDER_OPTIONS).optional(), dateTimeRenderOption: z.enum(DATE_RENDER_OPTIONS).optional(), maxRows: z.number().int().min(1).max(500).optional(), maxColumns: z.number().int().min(1).max(100).optional(), maxCells: z.number().int().min(1).max(20_000).optional()}),
  }, (input) => getValues(client, input));
  return ["sheets_get_spreadsheet", "sheets_get_values"];
}

export async function getSpreadsheet(client, input = {}) {
  const spreadsheetId = requiredText(input.spreadsheetId, "spreadsheetId", 512);
  const result = await client.request(`${SHEETS_API}/spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}?${queryParams({includeGridData: false, fields: "spreadsheetId,properties,sheets(properties(sheetId,title,index,sheetType,gridProperties,hidden))"})}`);
  return {
    spreadsheetId: result.spreadsheetId || spreadsheetId,
    properties: result.properties ? {title: result.properties.title || null, locale: result.properties.locale || null, timeZone: result.properties.timeZone || null} : null,
    sheets: Array.isArray(result.sheets) ? result.sheets.map((sheet) => compactSheet(sheet.properties || {})) : [],
  };
}

export async function getValues(client, input = {}) {
  const spreadsheetId = requiredText(input.spreadsheetId, "spreadsheetId", 512);
  const ranges = input.ranges.map((range) => requiredText(range, "range", 512));
  const result = await client.request(`${SHEETS_API}/spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}/values:batchGet?${queryParams({
    ranges,
    majorDimension: "ROWS",
    valueRenderOption: input.valueRenderOption || "FORMATTED_VALUE",
    dateTimeRenderOption: input.dateTimeRenderOption || "FORMATTED_STRING",
  })}`);
  const maxRows = boundedItemLimit(input.maxRows, 500, 500);
  const maxColumns = boundedItemLimit(input.maxColumns, 100, 100);
  const maxCells = boundedItemLimit(input.maxCells, 10_000, 20_000);
  let cells = 0;
  let truncated = false;
  const valueRanges = (Array.isArray(result?.valueRanges) ? result.valueRanges : []).map((valueRange) => {
    const values = [];
    for (const row of Array.isArray(valueRange.values) ? valueRange.values.slice(0, maxRows) : []) {
      if (values.length >= maxRows || cells >= maxCells) {
        truncated = true;
        break;
      }
      const boundedRow = Array.isArray(row) ? row.slice(0, maxColumns) : [];
      if (boundedRow.length < row.length) truncated = true;
      const remaining = maxCells - cells;
      const bounded = boundedRow.slice(0, remaining);
      if (bounded.length < boundedRow.length) truncated = true;
      cells += bounded.length;
      values.push(bounded);
    }
    if (Array.isArray(valueRange.values) && valueRange.values.length > values.length) truncated = true;
    return {range: valueRange.range || null, majorDimension: valueRange.majorDimension || "ROWS", values};
  });
  return {spreadsheetId, valueRanges, cellCount: cells, truncated};
}

function compactSheet(properties) {
  return Object.fromEntries(["sheetId", "title", "index", "sheetType", "gridProperties", "hidden"].filter((key) => properties[key] !== undefined).map((key) => [key, properties[key]]));
}
