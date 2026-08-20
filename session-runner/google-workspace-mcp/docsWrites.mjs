import * as z from "zod/v4";
import {pathSegment, registerJsonTool, requiredText} from "./tools.mjs";

const DOCS_API = "/docs/v1";
const ALLOWED_REQUESTS = new Set(["insertText", "deleteContentRange", "replaceAllText"]);

export function registerDocsWriteTools(server, {client, config}) {
  if (!canWrite(config)) return [];
  registerJsonTool(server, "docs_batch_update", {
    description: "Apply bounded allowlisted updates to a Google Doc.",
    inputSchema: z.object({documentId: z.string().min(1).max(512), requests: z.array(z.record(z.string(), z.unknown())).min(1).max(50), requiredRevisionId: z.string().max(512).optional()}),
  }, (input) => batchUpdate(client, input));
  return ["docs_batch_update"];
}

export async function batchUpdate(client, input = {}) {
  const documentId = requiredText(input.documentId, "documentId", 512);
  const requests = normalizeRequests(input.requests);
  const body = {requests};
  if (input.requiredRevisionId) body.writeControl = {requiredRevisionId: requiredText(input.requiredRevisionId, "requiredRevisionId", 512)};
  const result = await client.request(`${DOCS_API}/documents/${pathSegment(documentId, "documentId")}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    documentId: result.documentId || documentId,
    writeControl: result.writeControl ? {requiredRevisionId: result.writeControl.requiredRevisionId || null, targetRevisionId: result.writeControl.targetRevisionId || null} : null,
    replies: Array.isArray(result.replies) ? result.replies.slice(0, 50) : [],
  };
}

export function normalizeRequests(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) {
    const error = new Error("requests must contain between 1 and 50 updates.");
    error.code = "invalid_document_requests";
    throw error;
  }
  return value.map((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) invalidRequest();
    const keys = Object.keys(request);
    if (keys.length !== 1 || !ALLOWED_REQUESTS.has(keys[0])) invalidRequest();
    const key = keys[0];
    const payload = request[key];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidRequest();
    if (key === "insertText") return {insertText: normalizeInsertText(payload)};
    if (key === "deleteContentRange") return {deleteContentRange: normalizeDeleteRange(payload)};
    return {replaceAllText: normalizeReplaceAll(payload)};
  });
}

function normalizeInsertText(value) {
  const text = requiredText(value.text, "insertText", 20_000);
  const location = normalizeLocation(value.location);
  return {location, text};
}

function normalizeDeleteRange(value) {
  const range = value.range;
  if (!range || !Number.isSafeInteger(range.startIndex) || !Number.isSafeInteger(range.endIndex) || range.startIndex < 1 || range.endIndex <= range.startIndex || range.endIndex - range.startIndex > 100_000) {
    const error = new Error("delete range indices are invalid.");
    error.code = "invalid_document_range";
    throw error;
  }
  return {range: {startIndex: range.startIndex, endIndex: range.endIndex, ...(range.tabId ? {tabId: requiredText(range.tabId, "tabId", 256)} : {})}};
}

function normalizeReplaceAll(value) {
  const text = requiredText(value.containsText?.text, "containsText", 10_000);
  const replaceText = String(value.replaceText || "");
  if (replaceText.length > 20_000) {
    const error = new Error("replace text is too large.");
    error.code = "invalid_replace_text";
    throw error;
  }
  return {containsText: {text, matchCase: value.containsText?.matchCase !== false}, replaceText};
}

function normalizeLocation(value) {
  if (!value || !Number.isSafeInteger(value.index) || value.index < 1) {
    const error = new Error("insert location index is invalid.");
    error.code = "invalid_document_index";
    throw error;
  }
  return {index: value.index, ...(value.tabId ? {tabId: requiredText(value.tabId, "tabId", 256)} : {})};
}

function invalidRequest() {
  const error = new Error("document request type is not allowlisted.");
  error.code = "unsupported_document_request";
  throw error;
}

function canWrite(config) {
  return config?.hasWriteScope?.("docs") === true;
}
