import * as z from "zod/v4";
import {hasGrantedScope} from "./config.mjs";
import {pathSegment, registerJsonTool, requiredText} from "./tools.mjs";

const SLIDES_API = "/slides/v1";
const PRESENTATIONS_WRITE_SCOPE = "https://www.googleapis.com/auth/presentations";
const ALLOWED_REQUESTS = new Set(["createSlide", "deleteObject", "insertText", "deleteText", "replaceAllText"]);

export function registerSlidesWriteTools(server, {client, config}) {
  if (!canWrite(config)) return [];
  registerJsonTool(server, "slides_batch_update", {
    description: "Apply bounded allowlisted updates to a Google presentation.",
    inputSchema: z.object({presentationId: z.string().min(1).max(512), requests: z.array(z.record(z.string(), z.unknown())).min(1).max(50)}),
  }, (input) => batchUpdate(client, input));
  return ["slides_batch_update"];
}

export async function batchUpdate(client, input = {}) {
  const presentationId = requiredText(input.presentationId, "presentationId", 512);
  const requests = normalizeRequests(input.requests);
  const result = await client.request(`${SLIDES_API}/presentations/${pathSegment(presentationId, "presentationId")}:batchUpdate`, {method: "POST", body: JSON.stringify({requests})});
  const createdObjectIds = [];
  for (const reply of Array.isArray(result.replies) ? result.replies : []) {
    if (reply.createSlide?.objectId) createdObjectIds.push(reply.createSlide.objectId);
  }
  return {presentationId: result.presentationId || presentationId, createdObjectIds, writeControl: result.writeControl ? {requiredRevisionId: result.writeControl.requiredRevisionId || null} : null};
}

export function normalizeRequests(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) invalidRequests();
  return value.map((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) invalidRequests();
    const keys = Object.keys(request);
    if (keys.length !== 1 || !ALLOWED_REQUESTS.has(keys[0])) invalidRequests();
    const key = keys[0];
    const payload = request[key];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidRequests();
    if (key === "createSlide") return {createSlide: normalizeCreateSlide(payload)};
    if (key === "deleteObject") return {deleteObject: {objectId: requiredText(payload.objectId, "objectId", 256)}};
    if (key === "insertText") return {insertText: normalizeInsertText(payload)};
    if (key === "deleteText") return {deleteText: normalizeDeleteText(payload)};
    return {replaceAllText: normalizeReplaceAll(payload)};
  });
}

function normalizeCreateSlide(value) {
  const result = {};
  if (value.objectId) result.objectId = requiredText(value.objectId, "objectId", 256);
  if (value.insertionIndex != null) {
    if (!Number.isSafeInteger(value.insertionIndex) || value.insertionIndex < 0) invalidField("insertionIndex");
    result.insertionIndex = value.insertionIndex;
  }
  if (value.slideLayoutReference) {
    if (typeof value.slideLayoutReference !== "object" || Array.isArray(value.slideLayoutReference)) invalidField("slideLayoutReference");
    result.slideLayoutReference = Object.fromEntries(["predefinedLayout", "layoutId"].filter((key) => value.slideLayoutReference[key]).map((key) => [key, requiredText(value.slideLayoutReference[key], key, 256)]));
  }
  return result;
}

function normalizeInsertText(value) {
  const objectId = requiredText(value.objectId, "objectId", 256);
  const text = requiredText(value.text, "text", 20_000);
  const result = {objectId, text};
  if (value.insertionIndex != null) {
    if (!Number.isSafeInteger(value.insertionIndex) || value.insertionIndex < 0) invalidField("insertionIndex");
    result.insertionIndex = value.insertionIndex;
  }
  return result;
}

function normalizeDeleteText(value) {
  const objectId = requiredText(value.objectId, "objectId", 256);
  const range = value.textRange;
  if (!range || range.type !== "FIXED_RANGE" || !Number.isSafeInteger(range.startIndex) || !Number.isSafeInteger(range.endIndex) || range.startIndex < 0 || range.endIndex <= range.startIndex || range.endIndex - range.startIndex > 20_000) invalidField("textRange");
  return {objectId, textRange: {type: "FIXED_RANGE", startIndex: range.startIndex, endIndex: range.endIndex}};
}

function normalizeReplaceAll(value) {
  const containsText = value.containsText;
  const text = requiredText(containsText?.text, "containsText", 10_000);
  const replaceText = String(value.replaceText || "");
  if (replaceText.length > 20_000) invalidField("replaceText");
  return {containsText: {text, matchCase: containsText?.matchCase === true}, replaceText, ...(Array.isArray(value.pageObjectIds) ? {pageObjectIds: value.pageObjectIds.slice(0, 100).map((id) => requiredText(id, "pageObjectId", 256))} : {})};
}

function invalidRequests() {
  const error = new Error("presentation request type is not allowlisted.");
  error.code = "unsupported_presentation_request";
  throw error;
}

function invalidField(name) {
  const error = new Error(`${name} is invalid.`);
  error.code = "invalid_presentation_request";
  throw error;
}

function canWrite(config) {
  return config?.hasGrantedScope ? config.hasGrantedScope("slides", PRESENTATIONS_WRITE_SCOPE) : hasGrantedScope(config, "slides", PRESENTATIONS_WRITE_SCOPE);
}
