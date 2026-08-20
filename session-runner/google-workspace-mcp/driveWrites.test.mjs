import assert from "node:assert/strict";
import {test} from "node:test";
import {downloadFile, readFile, registerDriveWriteTools, createFile} from "./driveWrites.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

test("gates Drive downloads and writes by their scopes", () => {
  const server = fakeServer();
  const config = {hasReadScope: () => true, hasGrantedScope: (_service, scope) => scope === DRIVE_FILE_SCOPE};
  assert.deepEqual(registerDriveWriteTools(server, {client: {}, config}), ["drive_read_file", "drive_download_file", "drive_create_file", "drive_copy_file"]);
  const readOnly = fakeServer();
  assert.deepEqual(registerDriveWriteTools(readOnly, {client: {}, config: {hasReadScope: () => true, hasGrantedScope: () => false}}), ["drive_read_file", "drive_download_file"]);
});

test("reads ordinary text files as UTF-8 and preserves binary fallback", async () => {
  const requests = [];
  const client = {request: async (url, options) => {
    requests.push({url, options});
    if (!options) return url.includes("text-1") ? {id: "text-1", name: "notes.txt", mimeType: "text/plain"} : {id: "bin-1", name: "image.png", mimeType: "image/png"};
    return url.includes("text-1") ? new TextEncoder().encode("hello Drive") : new Uint8Array([1, 2, 3]);
  }};

  const textResult = await readFile(client, {fileId: "text-1"});
  assert.equal(textResult.contentText, "hello Drive");
  assert.equal(textResult.encoding, "utf-8");
  const binaryResult = await readFile(client, {fileId: "bin-1"});
  assert.equal(binaryResult.contentBase64, "AQID");
  assert.equal(binaryResult.encoding, "base64");
  assert.match(requests[1].url, /alt=media/);
});

test("exports Google Docs, Sheets, and Slides through Drive read scope", async () => {
  const cases = [
    ["application/vnd.google-apps.document", "text%2Fplain"],
    ["application/vnd.google-apps.spreadsheet", "text%2Fcsv"],
    ["application/vnd.google-apps.presentation", "text%2Fplain"],
  ];
  for (const [mimeType, encodedExport] of cases) {
    const requests = [];
    const result = await readFile({request: async (url, options) => {
      requests.push({url, options});
      return options ? new TextEncoder().encode("exported content") : {id: "native-1", name: "Native", mimeType};
    }}, {fileId: "native-1"});
    assert.equal(result.contentText, "exported content");
    assert.equal(result.encoding, "utf-8");
    assert.match(requests[1].url, /\/export\?/);
    assert.match(requests[1].url, new RegExp(`mimeType=${encodedExport}`));
  }
});

test("rejects Google-native file types without readable exports", async () => {
  await assert.rejects(readFile({request: async () => ({mimeType: "application/vnd.google-apps.folder"})}, {fileId: "folder-1"}), (error) => error.code === "google_native_file_not_readable");
});

test("rejects native files and returns bounded binary downloads", async () => {
  await assert.rejects(downloadFile({request: async () => ({mimeType: "application/vnd.google-apps.document"})}, {fileId: "doc-1"}), (error) => error.code === "google_native_file_requires_product_tool");
  const calls = [];
  const result = await downloadFile({request: async (url, options) => {
    calls.push({url, options});
    return options?.responseType === "bytes" ? new Uint8Array([1, 2, 3]) : {id: "file-1", name: "a.bin", mimeType: "application/octet-stream"};
  }}, {fileId: "file-1", maxBytes: 100});
  assert.equal(result.contentBase64, "AQID");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.responseType, "bytes");
});

test("creates multipart text content without embedding credentials", async () => {
  const calls = [];
  const result = await createFile({request: async (url, options) => {
    calls.push({url, options});
    return {id: "file-1", name: "hello.txt", mimeType: "text/plain"};
  }}, {name: "hello.txt", mimeType: "text/plain", content: "hello", encoding: "text"});
  assert.equal(result.file.id, "file-1");
  assert.match(calls[0].options.headers["content-type"], /multipart\/related/);
  assert.match(calls[0].options.body.toString(), /hello/);
});
