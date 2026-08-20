import * as z from "zod/v4";
import {boundedItemLimit, pathSegment, queryParams, registerJsonTool} from "./tools.mjs";

const DOCS_API = "/docs/v1";

export function registerDocsReadTools(server, {client, config}) {
  if (!config?.hasReadScope?.("docs")) return [];
  registerJsonTool(server, "docs_read_document", {
    description: "Read a compact structured Google Doc while preserving update indices.",
    inputSchema: z.object({documentId: z.string().min(1).max(512), maxElements: z.number().int().min(1).max(2_000).optional(), maxTextLength: z.number().int().min(1).max(500_000).optional()}),
  }, (input) => readDocument(client, input));
  return ["docs_read_document"];
}

export async function readDocument(client, input = {}) {
  const documentId = String(input.documentId || "").trim();
  const result = await client.request(`${DOCS_API}/documents/${pathSegment(documentId, "documentId")}?${queryParams({includeTabsContent: true})}`);
  return compactDocument(result, {
    maxElements: boundedItemLimit(input.maxElements, 500, 2_000),
    maxTextLength: boundedItemLimit(input.maxTextLength, 100_000, 500_000),
  });
}

export function compactDocument(document = {}, limits = {}) {
  const state = {elements: 0, textLength: 0, maxElements: limits.maxElements || 500, maxTextLength: limits.maxTextLength || 100_000};
  const tabs = Array.isArray(document.tabs) && document.tabs.length ? document.tabs : [{tabProperties: {tabId: "body", title: "Body", index: 0}, documentTab: {body: document.body || {content: []}}}];
  return {
    documentId: document.documentId || null,
    title: document.title || null,
    revisionId: document.revisionId || null,
    tabs: tabs.map((tab) => compactTab(tab, state)),
    truncated: state.elements >= state.maxElements || state.textLength >= state.maxTextLength,
  };
}

function compactTab(tab = {}, state) {
  const properties = tab.tabProperties || {};
  const body = tab.documentTab?.body || tab.body || {};
  return {
    tabId: properties.tabId || null,
    title: properties.title || null,
    index: properties.index ?? null,
    content: compactContent(body.content, state),
  };
}

function compactContent(content, state) {
  const output = [];
  for (const element of Array.isArray(content) ? content : []) {
    if (state.elements >= state.maxElements) break;
    state.elements += 1;
    if (element.paragraph) output.push(compactParagraph(element, state));
    else if (element.table) output.push(compactTable(element, state));
    else if (element.sectionBreak) output.push({type: "sectionBreak", startIndex: element.startIndex ?? null, endIndex: element.endIndex ?? null});
    else output.push({type: "element", startIndex: element.startIndex ?? null, endIndex: element.endIndex ?? null});
  }
  return output;
}

function compactParagraph(element, state) {
  const paragraph = element.paragraph || {};
  return {
    type: "paragraph",
    startIndex: element.startIndex ?? null,
    endIndex: element.endIndex ?? null,
    namedStyleType: paragraph.paragraphStyle?.namedStyleType || null,
    elements: (Array.isArray(paragraph.elements) ? paragraph.elements : []).map((item) => compactTextRun(item, state)).filter(Boolean),
  };
}

function compactTextRun(item, state) {
  if (!item.textRun) return null;
  const textRun = item.textRun;
  let content = String(textRun.content || "");
  if (state.textLength >= state.maxTextLength) return null;
  const remaining = state.maxTextLength - state.textLength;
  if (content.length > remaining) content = content.slice(0, remaining);
  state.textLength += content.length;
  return {
    type: "textRun",
    content,
    startIndex: item.startIndex ?? null,
    endIndex: item.endIndex ?? null,
    textStyle: textRun.textStyle ? compactTextStyle(textRun.textStyle) : null,
  };
}

function compactTable(element, state) {
  const table = element.table || {};
  return {
    type: "table",
    startIndex: element.startIndex ?? null,
    endIndex: element.endIndex ?? null,
    rows: (Array.isArray(table.tableRows) ? table.tableRows : []).map((row) => ({
      rowSpan: row.tableRowStyle?.minRowHeight || null,
      cells: (Array.isArray(row.tableCells) ? row.tableCells : []).map((cell) => ({
        content: compactContent(cell.content, state),
      })),
    })),
  };
}

function compactTextStyle(style) {
  return Object.fromEntries(["bold", "italic", "underline", "strikethrough", "link"].filter((key) => style[key] !== undefined).map((key) => [key, style[key]]));
}
