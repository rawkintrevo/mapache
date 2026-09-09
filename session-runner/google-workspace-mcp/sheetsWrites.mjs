import * as z from "zod/v4";
import {hasGrantedScope} from "./config.mjs";
import {pathSegment, queryParams, registerJsonTool, requiredText} from "./tools.mjs";

const SHEETS_API = "/sheets/v4";
const SPREADSHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const VALUE_INPUT_OPTIONS = ["RAW", "USER_ENTERED"];

export function registerSheetsWriteTools(server, {client, config}) {
  if (!canWrite(config)) return [];
  registerJsonTool(server, "sheets_update_values", {
    description: "Update one bounded Google Sheets A1 range.",
    inputSchema: z.object({spreadsheetId: z.string().min(1).max(512), range: z.string().min(1).max(512), values: z.array(z.array(z.unknown()).min(1).max(100)).min(1).max(500), valueInputOption: z.enum(VALUE_INPUT_OPTIONS).optional()}),
  }, (input) => updateValues(client, input));
  registerJsonTool(server, "sheets_batch_update_values", {
    description: "Update multiple bounded Google Sheets A1 ranges.",
    inputSchema: z.object({spreadsheetId: z.string().min(1).max(512), data: z.array(z.object({range: z.string().min(1).max(512), values: z.array(z.array(z.unknown()).min(1).max(100)).min(1).max(500)})).min(1).max(50), valueInputOption: z.enum(VALUE_INPUT_OPTIONS).optional()}),
  }, (input) => batchUpdateValues(client, input));
  registerJsonTool(server, "sheets_insert_dimension", {
    description: "Insert a bounded row or column range in Google Sheets.",
    inputSchema: z.object({spreadsheetId: z.string().min(1).max(512), sheetId: z.number().int().min(0), dimension: z.enum(["ROWS", "COLUMNS"]), startIndex: z.number().int().min(0), endIndex: z.number().int().min(1), inheritFromBefore: z.boolean().optional()}),
  }, (input) => insertDimension(client, input));
  return ["sheets_update_values", "sheets_batch_update_values", "sheets_insert_dimension"];
}

export async function updateValues(client, input = {}) {
  const spreadsheetId = requiredText(input.spreadsheetId, "spreadsheetId", 512);
  const range = requiredText(input.range, "range", 512);
  const values = normalizeValues(input.values);
  const result = await client.request(`${SHEETS_API}/spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}/values/${pathSegment(range, "range")}?${queryParams({valueInputOption: input.valueInputOption || "RAW", includeValuesInResponse: false})}`, {
    method: "PUT",
    body: JSON.stringify({range, majorDimension: "ROWS", values}),
  });
  return compactUpdateResult(result, {range});
}

export async function batchUpdateValues(client, input = {}) {
  const spreadsheetId = requiredText(input.spreadsheetId, "spreadsheetId", 512);
  const data = (Array.isArray(input.data) ? input.data : []).map((entry) => ({range: requiredText(entry.range, "range", 512), majorDimension: "ROWS", values: normalizeValues(entry.values)}));
  const result = await client.request(`${SHEETS_API}/spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({valueInputOption: input.valueInputOption || "RAW", data}),
  });
  return {spreadsheetId, totalUpdatedCells: result.totalUpdatedCells || 0, totalUpdatedRows: result.totalUpdatedRows || 0, totalUpdatedColumns: result.totalUpdatedColumns || 0, responses: Array.isArray(result.responses) ? result.responses.slice(0, 50).map((response) => compactUpdateResult(response, {})) : []};
}

export async function insertDimension(client, input = {}) {
  const spreadsheetId = requiredText(input.spreadsheetId, "spreadsheetId", 512);
  const startIndex = Number(input.startIndex);
  const endIndex = Number(input.endIndex);
  if (!Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndex) || startIndex < 0 || endIndex <= startIndex || endIndex - startIndex > 1_000) {
    const error = new Error("dimension indices are invalid or too large.");
    error.code = "invalid_dimension_range";
    throw error;
  }
  const request = {insertDimension: {range: {sheetId: input.sheetId, dimension: input.dimension, startIndex, endIndex}, inheritFromBefore: input.inheritFromBefore === true}};
  const result = await client.request(`${SHEETS_API}/spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}:batchUpdate`, {method: "POST", body: JSON.stringify({requests: [request]})});
  return {spreadsheetId, replies: Array.isArray(result.replies) ? result.replies.slice(0, 1) : []};
}

function normalizeValues(values) {
  const rows = Array.isArray(values) ? values : [];
  const cells = rows.reduce((count, row) => count + (Array.isArray(row) ? row.length : 0), 0);
  if (!rows.length || rows.length > 500 || cells > 20_000 || rows.some((row) => !Array.isArray(row) || row.length > 100)) {
    const error = new Error("Sheet values exceed the bounded write limit.");
    error.code = "sheet_values_too_large";
    throw error;
  }
  return rows;
}

function compactUpdateResult(result = {}, fallback = {}) {
  return {updatedRange: result.updatedRange || fallback.range || null, updatedRows: result.updatedRows || 0, updatedColumns: result.updatedColumns || 0, updatedCells: result.updatedCells || 0};
}

function canWrite(config) {
  return config?.hasGrantedScope ? config.hasGrantedScope("sheets", SPREADSHEETS_WRITE_SCOPE) : hasGrantedScope(config, "sheets", SPREADSHEETS_WRITE_SCOPE);
}
