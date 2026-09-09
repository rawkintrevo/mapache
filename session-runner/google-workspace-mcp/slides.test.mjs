import assert from "node:assert/strict";
import {test} from "node:test";
import {compactPresentation, registerSlidesReadTools} from "./slides.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("registers only the Slides read tool with read scope", () => {
  const server = fakeServer();
  assert.deepEqual(registerSlidesReadTools(server, {client: {}, config: {hasReadScope: () => true}}), ["slides_read_presentation"]);
  const blocked = fakeServer();
  assert.deepEqual(registerSlidesReadTools(blocked, {client: {}, config: {hasReadScope: () => false}}), []);
});

test("preserves slide order, objects, text, tables, and speaker notes", () => {
  const result = compactPresentation({presentationId: "deck-1", title: "Deck", slides: [{objectId: "slide-1", pageElements: [
    {objectId: "shape-1", shape: {shapeType: "TEXT_BOX", text: {textElements: [{textRun: {content: "Hello", style: {bold: true}}}]}}},
    {objectId: "table-1", table: {tableRows: [{tableCells: [{text: {textElements: [{textRun: {content: "Cell"}}]}}]}]}},
  ], slideProperties: {notesPage: {pageElements: [{shape: {text: {textElements: [{textRun: {content: "Speaker note"}}]}}}]}}}]});
  assert.equal(result.slides[0].index, 0);
  assert.equal(result.slides[0].elements[0].text, "Hello");
  assert.equal(result.slides[0].elements[1].table.rows[0].cells[0], "Cell");
  assert.equal(result.slides[0].speakerNotes, "Speaker note");
});
