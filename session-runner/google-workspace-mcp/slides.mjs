import * as z from "zod/v4";
import {boundedItemLimit, pathSegment, queryParams, registerJsonTool, requiredText} from "./tools.mjs";

const SLIDES_API = "/slides/v1";

export function registerSlidesReadTools(server, {client, config}) {
  if (!config?.hasReadScope?.("slides")) return [];
  registerJsonTool(server, "slides_read_presentation", {
    description: "Read a bounded structured Google Slides presentation.",
    inputSchema: z.object({presentationId: z.string().min(1).max(512), maxSlides: z.number().int().min(1).max(500).optional(), maxElements: z.number().int().min(1).max(5_000).optional(), maxTextLength: z.number().int().min(1).max(500_000).optional()}),
  }, (input) => readPresentation(client, input));
  return ["slides_read_presentation"];
}

export async function readPresentation(client, input = {}) {
  const presentationId = requiredText(input.presentationId, "presentationId", 512);
  const result = await client.request(`${SLIDES_API}/presentations/${pathSegment(presentationId, "presentationId")}?${queryParams({fields: "presentationId,title,locale,pageSize,slides"})}`);
  return compactPresentation(result, {
    maxSlides: boundedItemLimit(input.maxSlides, 100, 500),
    maxElements: boundedItemLimit(input.maxElements, 1_000, 5_000),
    maxTextLength: boundedItemLimit(input.maxTextLength, 100_000, 500_000),
  });
}

export function compactPresentation(presentation = {}, limits = {}) {
  const state = {elementCount: 0, textLength: 0, maxElements: limits.maxElements || 1_000, maxTextLength: limits.maxTextLength || 100_000};
  const slides = Array.isArray(presentation.slides) ? presentation.slides.slice(0, limits.maxSlides || 100) : [];
  return {
    presentationId: presentation.presentationId || null,
    title: presentation.title || null,
    locale: presentation.locale || null,
    pageSize: presentation.pageSize || null,
    slides: slides.map((slide, index) => compactSlide(slide, index, state)),
    truncated: slides.length < (Array.isArray(presentation.slides) ? presentation.slides.length : 0) || state.elementCount >= state.maxElements || state.textLength >= state.maxTextLength,
  };
}

function compactSlide(slide = {}, index, state) {
  const elements = [];
  for (const element of Array.isArray(slide.pageElements) ? slide.pageElements : []) {
    if (state.elementCount >= state.maxElements) break;
    state.elementCount += 1;
    elements.push(compactElement(element, state));
  }
  return {
    index,
    objectId: slide.objectId || null,
    slideProperties: slide.slideProperties ? {layoutObjectId: slide.slideProperties.layoutObjectId || null, masterObjectId: slide.slideProperties.masterObjectId || null} : null,
    elements,
    speakerNotes: compactNotes(slide.slideProperties?.notesPage, state),
  };
}

function compactElement(element = {}, state) {
  const base = {objectId: element.objectId || null, elementType: elementType(element)};
  if (element.shape) base.shapeType = element.shape.shapeType || null;
  if (element.table) base.table = compactTable(element.table, state);
  const text = extractText(element.shape?.text?.textElements || element.text?.textElements || [], state);
  if (text.text) base.text = text.text;
  if (text.textRuns.length) base.textRuns = text.textRuns;
  return base;
}

function compactNotes(notesPage = {}, state) {
  const text = extractText((notesPage.pageElements || []).flatMap((element) => element.shape?.text?.textElements || []), state);
  return text.text || null;
}

function compactTable(table = {}, state) {
  return {
    rows: (table.tableRows || []).slice(0, 100).map((row) => ({cells: (row.tableCells || []).slice(0, 100).map((cell) => extractText(cell.text?.textElements || [], state).text)})),
  };
}

function extractText(elements, state) {
  const textRuns = [];
  let text = "";
  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element.textRun) continue;
    const content = String(element.textRun.content || "");
    const remaining = state.maxTextLength - state.textLength;
    if (remaining <= 0) break;
    const bounded = content.slice(0, remaining);
    state.textLength += bounded.length;
    text += bounded;
    textRuns.push({content: bounded, style: element.textRun.style ? compactTextStyle(element.textRun.style) : null});
  }
  return {text, textRuns};
}

function compactTextStyle(style) {
  return Object.fromEntries(["bold", "italic", "underline", "link"].filter((key) => style[key] !== undefined).map((key) => [key, style[key]]));
}

function elementType(element) {
  if (element.shape) return "shape";
  if (element.table) return "table";
  if (element.image) return "image";
  if (element.video) return "video";
  if (element.sheetsChart) return "sheetsChart";
  return "unknown";
}
