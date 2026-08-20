import * as z from "zod/v4";
import {hasGrantedScope} from "./config.mjs";
import {pathSegment, queryParams, registerJsonTool, requiredText} from "./tools.mjs";

const GMAIL_API = "/gmail/v1/users/me";
const COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const DRAFT_SCHEMA = z.object({
  from: z.string().max(320).optional(),
  to: z.array(z.string().min(1).max(320)).min(1).max(100),
  cc: z.array(z.string().min(1).max(320)).max(100).optional(),
  bcc: z.array(z.string().min(1).max(320)).max(100).optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(100_000),
  replyTo: z.string().max(320).optional(),
  messageId: z.string().max(998).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.string().max(998).optional(),
  threadId: z.string().max(512).optional(),
});
const LABEL_SCHEMA = z.array(z.string().min(1).max(256)).min(1).max(50);

export function registerGmailWriteTools(server, {client, config}) {
  const registered = [];
  const canCompose = canScope(config, COMPOSE_SCOPE);
  const canModify = canScope(config, MODIFY_SCOPE);
  if (canCompose) {
    registerJsonTool(server, "gmail_create_draft", {
      description: "Create a Gmail draft without sending it.",
      inputSchema: z.object({draft: DRAFT_SCHEMA}),
    }, (input) => createDraft(client, input));
    registerJsonTool(server, "gmail_update_draft", {
      description: "Update one Gmail draft without sending it.",
      inputSchema: z.object({draftId: z.string().min(1).max(512), draft: DRAFT_SCHEMA}),
    }, (input) => updateDraft(client, input));
    registered.push("gmail_create_draft", "gmail_update_draft");
  }
  if (canModify) {
    registerJsonTool(server, "gmail_label_message", {
      description: "Add labels to one Gmail message.",
      inputSchema: z.object({messageId: z.string().min(1).max(512), labelIds: LABEL_SCHEMA}),
    }, (input) => modifyLabels(client, "message", input, "addLabelIds"));
    registerJsonTool(server, "gmail_unlabel_message", {
      description: "Remove labels from one Gmail message.",
      inputSchema: z.object({messageId: z.string().min(1).max(512), labelIds: LABEL_SCHEMA}),
    }, (input) => modifyLabels(client, "message", input, "removeLabelIds"));
    registerJsonTool(server, "gmail_label_thread", {
      description: "Add labels to one Gmail thread.",
      inputSchema: z.object({threadId: z.string().min(1).max(512), labelIds: LABEL_SCHEMA}),
    }, (input) => modifyLabels(client, "thread", input, "addLabelIds"));
    registerJsonTool(server, "gmail_unlabel_thread", {
      description: "Remove labels from one Gmail thread.",
      inputSchema: z.object({threadId: z.string().min(1).max(512), labelIds: LABEL_SCHEMA}),
    }, (input) => modifyLabels(client, "thread", input, "removeLabelIds"));
    registered.push("gmail_label_message", "gmail_unlabel_message", "gmail_label_thread", "gmail_unlabel_thread");
  }
  return registered;
}

export async function createDraft(client, input = {}) {
  const draft = normalizeDraft(input.draft);
  const response = await client.request(`${GMAIL_API}/drafts`, {
    method: "POST",
    body: JSON.stringify({message: {raw: encodeRfc2822(draft), ...(draft.threadId ? {threadId: draft.threadId} : {})}}),
  });
  return compactDraft(response);
}

export async function updateDraft(client, input = {}) {
  const draftId = pathSegment(input.draftId, "draftId");
  const draft = normalizeDraft(input.draft);
  const response = await client.request(`${GMAIL_API}/drafts/${draftId}`, {
    method: "PUT",
    body: JSON.stringify({message: {raw: encodeRfc2822(draft), ...(draft.threadId ? {threadId: draft.threadId} : {})}}),
  });
  return compactDraft(response);
}

export async function modifyLabels(client, type, input = {}, operation = "addLabelIds") {
  const idKey = type === "thread" ? "threadId" : "messageId";
  const id = pathSegment(input[idKey], idKey);
  const labelIds = normalizeLabels(input.labelIds);
  const response = await client.request(`${GMAIL_API}/${type}s/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({[operation]: labelIds}),
  });
  return {type, id: response?.id || input[idKey], addedLabelIds: operation === "addLabelIds" ? labelIds : [], removedLabelIds: operation === "removeLabelIds" ? labelIds : []};
}

export function encodeRfc2822(draft) {
  const lines = [];
  if (draft.from) lines.push(`From: ${draft.from}`);
  lines.push(`To: ${draft.to.join(", ")}`);
  if (draft.cc?.length) lines.push(`Cc: ${draft.cc.join(", ")}`);
  if (draft.bcc?.length) lines.push(`Bcc: ${draft.bcc.join(", ")}`);
  if (draft.replyTo) lines.push(`Reply-To: ${draft.replyTo}`);
  if (draft.messageId) lines.push(`Message-ID: ${draft.messageId}`);
  if (draft.inReplyTo) lines.push(`In-Reply-To: ${draft.inReplyTo}`);
  if (draft.references) lines.push(`References: ${draft.references}`);
  lines.push(`Subject: ${draft.subject || ""}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", draft.body);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function normalizeDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("draft is required.");
    error.code = "invalid_draft";
    throw error;
  }
  const draft = {...value};
  if (!Array.isArray(draft.to) || !draft.to.length) {
    const error = new Error("draft recipients are required.");
    error.code = "draft_recipients_required";
    throw error;
  }
  if (JSON.stringify(draft).length > 120_000) {
    const error = new Error("draft is too large.");
    error.code = "draft_too_large";
    throw error;
  }
  return draft;
}

function normalizeLabels(value) {
  const labels = [...new Set((Array.isArray(value) ? value : []).map((label) => String(label || "").trim()).filter(Boolean))];
  if (!labels.length || labels.length > 50 || labels.some((label) => label.length > 256)) {
    const error = new Error("labelIds are required and bounded.");
    error.code = "invalid_label_ids";
    throw error;
  }
  return labels;
}

function compactDraft(draft = {}) {
  return {id: draft.id || null, messageId: draft.message?.id || null, threadId: draft.message?.threadId || null, message: draft.message ? {id: draft.message.id || null, threadId: draft.message.threadId || null, labelIds: draft.message.labelIds || []} : null};
}

function canScope(config, scope) {
  return config?.hasGrantedScope ? config.hasGrantedScope("gmail", scope) : hasGrantedScope(config, "gmail", scope);
}
