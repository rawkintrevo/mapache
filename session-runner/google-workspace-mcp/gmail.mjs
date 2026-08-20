import * as z from "zod/v4";
import {
  boundedItemLimit,
  boundedPageSize,
  pathSegment,
  queryParams,
  registerJsonTool,
  requiredText,
} from "./tools.mjs";

const GMAIL_API = "/gmail/v1/users/me";

export function registerGmailReadTools(server, {client, config}) {
  if (!config?.hasReadScope?.("gmail")) return [];
  registerJsonTool(server, "gmail_search_threads", {
    description: "Search Gmail threads with a bounded Gmail query.",
    inputSchema: z.object({query: z.string().max(512).optional(), pageSize: z.number().int().min(1).max(100).optional(), maxItems: z.number().int().min(1).max(500).optional()}),
  }, (input) => searchThreads(client, input));
  registerJsonTool(server, "gmail_get_thread", {
    description: "Get a compact Gmail thread with decoded text and attachment metadata.",
    inputSchema: z.object({threadId: z.string().min(1).max(512), format: z.enum(["full", "metadata", "minimal"]).optional()}),
  }, (input) => getThread(client, input));
  registerJsonTool(server, "gmail_get_message", {
    description: "Get one compact Gmail message without downloading attachments.",
    inputSchema: z.object({messageId: z.string().min(1).max(512), format: z.enum(["full", "metadata", "minimal"]).optional()}),
  }, (input) => getMessage(client, input));
  registerJsonTool(server, "gmail_list_labels", {
    description: "List Gmail labels.",
    inputSchema: z.object({}),
  }, () => listLabels(client));
  registerJsonTool(server, "gmail_list_drafts", {
    description: "List Gmail drafts without returning binary attachments.",
    inputSchema: z.object({pageSize: z.number().int().min(1).max(100).optional(), maxItems: z.number().int().min(1).max(500).optional()}),
  }, (input) => listDrafts(client, input));
  return ["gmail_search_threads", "gmail_get_thread", "gmail_get_message", "gmail_list_labels", "gmail_list_drafts"];
}

export async function searchThreads(client, input = {}) {
  const result = await client.paginate((params) => client.request(`${GMAIL_API}/threads?${queryParams({
    ...params,
    q: input.query || "",
    maxResults: boundedPageSize(input.pageSize),
  })}`), {maxItems: boundedItemLimit(input.maxItems)});
  return {threads: result.items.map((thread) => ({id: thread.id || null, snippet: thread.snippet || null, historyId: thread.historyId || null})), pages: result.pages, truncated: result.truncated, nextPageToken: result.nextPageToken};
}

export async function getThread(client, input = {}) {
  const threadId = pathSegment(input.threadId, "threadId");
  const thread = await client.request(`${GMAIL_API}/threads/${threadId}?${queryParams({format: input.format || "full"})}`);
  return {
    id: thread.id || null,
    historyId: thread.historyId || null,
    snippet: thread.snippet || null,
    messages: Array.isArray(thread.messages) ? thread.messages.map(compactMessage) : [],
  };
}

export async function getMessage(client, input = {}) {
  const messageId = pathSegment(input.messageId, "messageId");
  return {message: compactMessage(await client.request(`${GMAIL_API}/messages/${messageId}?${queryParams({format: input.format || "full"})}`))};
}

export async function listLabels(client) {
  const result = await client.request(`${GMAIL_API}/labels`);
  return {labels: Array.isArray(result?.labels) ? result.labels.map((label) => ({id: label.id || null, name: label.name || null, type: label.type || null, messageListVisibility: label.messageListVisibility || null, labelListVisibility: label.labelListVisibility || null})) : []};
}

export async function listDrafts(client, input = {}) {
  const result = await client.paginate((params) => client.request(`${GMAIL_API}/drafts?${queryParams({
    ...params,
    maxResults: boundedPageSize(input.pageSize),
  })}`), {maxItems: boundedItemLimit(input.maxItems)});
  return {drafts: result.items.map((draft) => ({id: draft.id || null, message: draft.message ? compactMessage(draft.message) : null})), pages: result.pages, truncated: result.truncated, nextPageToken: result.nextPageToken};
}

export function compactMessage(message = {}) {
  const payload = message.payload || {};
  const content = extractMimeContent(payload);
  return {
    id: message.id || null,
    threadId: message.threadId || null,
    labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
    snippet: message.snippet || null,
    internalDate: message.internalDate || null,
    headers: compactHeaders(payload.headers),
    plainText: content.plainText,
    html: content.html,
    attachments: content.attachments,
    mimeDecodeError: content.mimeDecodeError,
  };
}

export function extractMimeContent(payload = {}) {
  const state = {plainText: null, html: null, attachments: [], mimeDecodeError: false};
  visitPart(payload, state);
  return state;
}

function visitPart(part, state) {
  const mimeType = String(part.mimeType || "").toLowerCase();
  const filename = String(part.filename || "").trim();
  if (filename || part.body?.attachmentId) {
    state.attachments.push({
      attachmentId: part.body?.attachmentId || null,
      filename: filename || null,
      mimeType: mimeType || null,
      size: Number.isSafeInteger(part.body?.size) ? part.body.size : Number(part.body?.size || 0) || 0,
    });
  }
  if (mimeType === "text/plain" && part.body?.data && state.plainText == null) state.plainText = decodeMimeText(part.body.data, state);
  if (mimeType === "text/html" && part.body?.data && state.html == null) state.html = decodeMimeText(part.body.data, state);
  for (const child of Array.isArray(part.parts) ? part.parts : []) visitPart(child, state);
}

export function decodeMimeText(value, state = {mimeDecodeError: false}) {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text || /[^A-Za-z0-9+/_=-]/.test(text) || text.length % 4 === 1) {
    state.mimeDecodeError = true;
    return null;
  }
  try {
    return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch (error) {
    state.mimeDecodeError = true;
    return null;
  }
}

function compactHeaders(headers) {
  const wanted = new Set(["from", "to", "cc", "bcc", "subject", "date", "message-id", "in-reply-to", "references"]);
  return Object.fromEntries((Array.isArray(headers) ? headers : [])
      .map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")])
      .filter(([name]) => wanted.has(name)));
}
