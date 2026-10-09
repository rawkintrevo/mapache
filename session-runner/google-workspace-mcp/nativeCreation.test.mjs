import assert from "node:assert/strict";
import {test} from "node:test";
import {createGoogleRestClient} from "./restClient.mjs";
import {createDocument, batchUpdate as updateDocument, registerDocsWriteTools} from "./docsWrites.mjs";
import {createPresentation, batchUpdate as updatePresentation, registerSlidesWriteTools} from "./slidesWrites.mjs";
import {readDocument} from "./docs.mjs";
import {readPresentation} from "./slides.mjs";
import {createFile, copyFile} from "./driveWrites.mjs";
import {createGoogleWorkspaceConfig} from "./config.mjs";

function recordingClient(result = {}) {
  const calls = [];
  const client = createGoogleRestClient({env: {GOOGLE_MCP_ACCESS_TOKEN: "test-token"}, fetchImpl: async (url, options) => {
    calls.push({url: new URL(url), options});
    return Response.json(result);
  }});
  return {calls, client};
}

for (const [service, idKey, resource, create, read, update, requests] of [
  ["docs", "documentId", "documents", createDocument, readDocument, updateDocument, [{insertText: {location: {index: 1}, text: "Hello"}}]],
  ["slides", "presentationId", "presentations", createPresentation, readPresentation, updatePresentation, [{createSlide: {}}]],
]) {
  test(`${service} creates, reads and edits via its dedicated service host`, async () => {
    const {calls, client} = recordingClient({[idKey]: "native-1", title: "Planning"});
    const created = await create(client, {title: "Planning"});
    assert.equal(created[idKey], "native-1");
    assert.match(created.url, /^https:\/\/docs.google.com\/(document|presentation)\/d\/native-1\/edit$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {title: "Planning"});
    await read(client, {[idKey]: created[idKey]});
    await update(client, {[idKey]: created[idKey], requests});
    assert.deepEqual(calls.map(({url, options}) => [url.origin, url.pathname, options.method || "GET"]), [
      [`https://${service}.googleapis.com`, `/v1/${resource}`, "POST"],
      [`https://${service}.googleapis.com`, `/v1/${resource}/native-1`, "GET"],
      [`https://${service}.googleapis.com`, `/v1/${resource}/native-1:batchUpdate`, "POST"],
    ]);
    await assert.rejects(create(client, {title: "   "}), {code: "invalid_title"});
    await assert.rejects(create(client, {title: "x".repeat(257)}), {code: "invalid_title"});
    assert.equal(calls.length, 3);
    await assert.rejects(create(recordingClient().client, {title: "Planning"}), {code: `invalid_${idKey}`});
  });
}

for (const type of ["document", "spreadsheet", "presentation"]) {
  test(`Drive creates a blank native ${type} in the requested folder and copies it`, async () => {
    const mimeType = `application/vnd.google-apps.${type}`;
    const {calls, client} = recordingClient({id: "file-1", mimeType});
    await createFile(client, {name: "Planning", mimeType, parents: ["folder-1"]});
    assert.equal(calls[0].url.origin, "https://www.googleapis.com");
    assert.equal(calls[0].url.pathname, "/drive/v3/files");
    assert.equal(calls[0].options.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0].options.body), {name: "Planning", mimeType, parents: ["folder-1"]});
    await copyFile(client, {fileId: "file-1", name: "Copy"});
    assert.equal(calls[1].url.pathname, "/drive/v3/files/file-1/copy");
    assert.deepEqual(JSON.parse(calls[1].options.body), {name: "Copy"});
  });
}

for (const [type, contentMimeType, content, encoding] of [
  ["document", "text/plain", "Hello", "text"],
  ["document", "text/html", "<p>Hello</p>", "text"],
  ["presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "AP8=", "base64"],
]) {
  test(`Drive imports ${contentMimeType} into ${type}`, async () => {
    const {calls, client} = recordingClient({id: "imported"});
    await createFile(client, {name: "Imported", mimeType: `application/vnd.google-apps.${type}`, contentMimeType, content, encoding});
    assert.equal(calls[0].url.pathname, "/upload/drive/v3/files");
    const body = calls[0].options.body;
    assert.ok(body.includes(Buffer.from(`Content-Type: ${contentMimeType}\r\n`)));
    assert.ok(body.includes(Buffer.from(content, encoding === "base64" ? "base64" : "utf8")));
  });
}

test("creation tools require enabled services and write grants", () => {
  const allScopes = ["drive.readonly", "drive.file", "documents.readonly", "documents", "presentations.readonly", "presentations"];
  for (const [services, scopes, allowed] of [
    ["docs,slides", [], false],
    ["docs,slides", ["drive.readonly", "documents.readonly", "presentations.readonly"], false],
    ["", allScopes, false],
    ["docs,slides", allScopes, true],
  ]) {
    const config = createGoogleWorkspaceConfig({env: {GOOGLE_MCP_ENABLED_SERVICES: services, GOOGLE_MCP_GRANTED_SCOPES: JSON.stringify(scopes.map((s) => `https://www.googleapis.com/auth/${s}`))}});
    const registered = [];
    const server = {registerTool(name) {registered.push(name);}};
    registerDocsWriteTools(server, {client: {}, config});
    registerSlidesWriteTools(server, {client: {}, config});
    assert.deepEqual(registered, allowed ? ["docs_create_document", "docs_batch_update", "slides_create_presentation", "slides_batch_update"] : []);
  }
});
