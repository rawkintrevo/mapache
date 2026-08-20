import * as z from "zod/v4";
import {randomUUID} from "node:crypto";
import {hasGrantedScope} from "./config.mjs";
import {compactFile} from "./drive.mjs";
import {boundedItemLimit, pathSegment, queryParams, registerJsonTool, requiredText} from "./tools.mjs";

const DRIVE_API = "/drive/v3";
const UPLOAD_API = "/upload/drive/v3";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const NATIVE_FILE_PREFIX = "application/vnd.google-apps.";
const FILE_FIELDS = "id,name,mimeType,description,modifiedTime,createdTime,webViewLink,size,parents,driveId,trashed";

export function registerDriveWriteTools(server, {client, config}) {
  const registered = [];
  if (config?.hasReadScope?.("drive")) {
    registerJsonTool(server, "drive_download_file", {
      description: "Download a bounded non-native Drive file as base64.",
      inputSchema: z.object({fileId: z.string().min(1).max(512), maxBytes: z.number().int().min(1).max(5_000_000).optional()}),
    }, (input) => downloadFile(client, input));
    registered.push("drive_download_file");
  }
  if (canWrite(config)) {
    registerJsonTool(server, "drive_create_file", {
      description: "Create a small text or base64 Drive file.",
      inputSchema: z.object({name: z.string().min(1).max(256), mimeType: z.string().min(1).max(256), content: z.string().max(2_000_000), encoding: z.enum(["text", "base64"]).optional(), parents: z.array(z.string().min(1).max(512)).max(20).optional()}),
    }, (input) => createFile(client, input));
    registerJsonTool(server, "drive_copy_file", {
      description: "Copy one Drive file within the authorized Drive scope.",
      inputSchema: z.object({fileId: z.string().min(1).max(512), name: z.string().max(256).optional(), parents: z.array(z.string().min(1).max(512)).max(20).optional()}),
    }, (input) => copyFile(client, input));
    registered.push("drive_create_file", "drive_copy_file");
  }
  return registered;
}

export async function downloadFile(client, input = {}) {
  const fileId = requiredText(input.fileId, "fileId", 512);
  const metadata = await client.request(`${DRIVE_API}/files/${pathSegment(fileId, "fileId")}?${queryParams({fields: FILE_FIELDS})}`);
  const mimeType = String(metadata?.mimeType || "");
  if (mimeType.startsWith(NATIVE_FILE_PREFIX)) {
    const error = new Error("Google-native files must use the matching product tool.");
    error.code = "google_native_file_requires_product_tool";
    throw error;
  }
  const bytes = await client.request(`${DRIVE_API}/files/${pathSegment(fileId, "fileId")}?alt=media`, {
    responseType: "bytes",
    maxResponseBytes: Math.min(Number(input.maxBytes) || 1_000_000, 5_000_000),
  });
  return {file: compactFile(metadata), contentBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength};
}

export async function createFile(client, input = {}) {
  const name = requiredText(input.name, "name", 256);
  const mimeType = requiredText(input.mimeType, "mimeType", 256);
  const content = decodeContent(input.content, input.encoding || "text");
  const boundary = `mapache-${randomUUID()}`;
  const metadata = {name, mimeType, ...(input.parents?.length ? {parents: input.parents} : {})};
  const body = multipartBody(boundary, metadata, content);
  const result = await client.request(`${UPLOAD_API}/files?${queryParams({uploadType: "multipart", fields: FILE_FIELDS})}`, {
    method: "POST",
    headers: {"content-type": `multipart/related; boundary=${boundary}`},
    body,
  });
  return {file: compactFile(result)};
}

export async function copyFile(client, input = {}) {
  const fileId = pathSegment(input.fileId, "fileId");
  const result = await client.request(`${DRIVE_API}/files/${fileId}/copy?${queryParams({fields: FILE_FIELDS})}`, {
    method: "POST",
    body: JSON.stringify({...(input.name ? {name: input.name} : {}), ...(input.parents?.length ? {parents: input.parents} : {})}),
  });
  return {file: compactFile(result)};
}

function canWrite(config) {
  return config?.hasGrantedScope ? config.hasGrantedScope("drive", DRIVE_FILE_SCOPE) : hasGrantedScope(config, "drive", DRIVE_FILE_SCOPE);
}

function decodeContent(value, encoding) {
  const text = String(value || "");
  if (encoding === "text") return Buffer.from(text, "utf8");
  if (encoding !== "base64" || !/^[A-Za-z0-9+/=_-]*$/.test(text)) {
    const error = new Error("content encoding is invalid.");
    error.code = "invalid_file_content";
    throw error;
  }
  try {
    return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch (error) {
    const invalid = new Error("content encoding is invalid.");
    invalid.code = "invalid_file_content";
    throw invalid;
  }
}

function multipartBody(boundary, metadata, content) {
  const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`;
  return Buffer.concat([Buffer.from(prefix, "utf8"), content, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
}
