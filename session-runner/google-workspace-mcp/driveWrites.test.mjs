import assert from "node:assert/strict";
import {test} from "node:test";
import {downloadFile, registerDriveWriteTools, createFile} from "./driveWrites.mjs";

function fakeServer() {
  const tools = new Map();
  return {tools, registerTool(name, config, handler) {tools.set(name, {config, handler});}};
}

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

test("gates Drive downloads and writes by their scopes", () => {
  const server = fakeServer();
  const config = {hasReadScope: () => true, hasGrantedScope: (_service, scope) => scope === DRIVE_FILE_SCOPE};
  assert.deepEqual(registerDriveWriteTools(server, {client: {}, config}), ["drive_download_file", "drive_create_file", "drive_copy_file"]);
  const readOnly = fakeServer();
  assert.deepEqual(registerDriveWriteTools(readOnly, {client: {}, config: {hasReadScope: () => true, hasGrantedScope: () => false}}), ["drive_download_file"]);
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
