import assert from "node:assert/strict";
import {test} from "node:test";
import {compactDocument, readDocument, registerDocsReadTools} from "./docs.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

test("registers Docs read support only with documents read scopes", () => {
  const server = fakeServer();
  assert.deepEqual(registerDocsReadTools(server, {client: {}, config: {hasReadScope: () => true}}), ["docs_read_document"]);
  const blocked = fakeServer();
  assert.deepEqual(registerDocsReadTools(blocked, {client: {}, config: {hasReadScope: () => false}}), []);
});

test("compacts paragraphs, nested tables, tabs, and text indices", () => {
  const result = compactDocument({
    documentId: "doc-1",
    title: "Notes",
    revisionId: "rev-1",
    tabs: [{
      tabProperties: {tabId: "tab-1", title: "First", index: 0},
      documentTab: {body: {content: [
        {
          startIndex: 1,
          endIndex: 6,
          paragraph: {
            paragraphStyle: {namedStyleType: "NORMAL_TEXT"},
            elements: [{startIndex: 1, endIndex: 6, textRun: {content: "Hello", textStyle: {bold: true}}}],
          },
        },
        {
          startIndex: 6,
          endIndex: 20,
          table: {
            tableRows: [{tableCells: [{content: [{
              startIndex: 7,
              endIndex: 12,
              paragraph: {elements: [{startIndex: 7, endIndex: 12, textRun: {content: "Cell\n"}}]},
            }]}]}],
          },
        },
      ]}},
    }],
  });
  assert.equal(result.tabs[0].tabId, "tab-1");
  assert.equal(result.tabs[0].content[0].elements[0].content, "Hello");
  assert.equal(result.tabs[0].content[0].elements[0].startIndex, 1);
  assert.equal(result.tabs[0].content[1].rows[0].cells[0].content[0].type, "paragraph");
  assert.equal(result.tabs[0].content[1].rows[0].cells[0].content[0].elements[0].content, "Cell\n");
});

test("reads a body-only document with bounded output", async () => {
  const calls = [];
  const result = await readDocument({request: async (url) => {
    calls.push(url);
    return {documentId: "doc-1", body: {content: []}};
  }}, {documentId: "doc-1", maxElements: 1});
  assert.match(calls[0], /includeTabsContent=true/);
  assert.equal(result.documentId, "doc-1");
});
