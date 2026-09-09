import * as z from "zod/v4";
import {
  boundedItemLimit,
  boundedPageSize,
  pathSegment,
  queryParams,
  registerJsonTool,
} from "./tools.mjs";

const DRIVE_API = "/drive/v3";
const FILE_FIELDS = "nextPageToken,files(id,name,mimeType,description,modifiedTime,createdTime,webViewLink,size,parents,driveId,trashed,owners(displayName,emailAddress))";
const PERMISSION_FIELDS = "nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery),inheritedPermissions";

const sharedDriveSchema = {
  driveId: z.string().max(512).optional(),
  includeAllDrives: z.boolean().optional(),
};

export function registerDriveReadTools(server, {client, config}) {
  if (!config?.hasReadScope?.("drive")) return [];
  registerJsonTool(server, "drive_search_files", {
    description: "Search Drive files by bounded typed filters.",
    inputSchema: z.object({nameContains: z.string().max(256).optional(), mimeType: z.string().max(256).optional(), query: z.string().max(1024).optional(), pageSize: z.number().int().min(1).max(100).optional(), maxItems: z.number().int().min(1).max(500).optional(), ...sharedDriveSchema}),
  }, (input) => searchFiles(client, input));
  registerJsonTool(server, "drive_list_recent_files", {
    description: "List recently modified Drive files.",
    inputSchema: z.object({pageSize: z.number().int().min(1).max(100).optional(), maxItems: z.number().int().min(1).max(500).optional(), ...sharedDriveSchema}),
  }, (input) => listRecentFiles(client, input));
  registerJsonTool(server, "drive_get_file_metadata", {
    description: "Get bounded metadata for one Drive file.",
    inputSchema: z.object({fileId: z.string().min(1).max(512), ...sharedDriveSchema}),
  }, (input) => getFileMetadata(client, input));
  registerJsonTool(server, "drive_get_file_permissions", {
    description: "Get bounded permissions for one Drive file.",
    inputSchema: z.object({fileId: z.string().min(1).max(512), pageSize: z.number().int().min(1).max(100).optional(), maxItems: z.number().int().min(1).max(500).optional(), ...sharedDriveSchema}),
  }, (input) => getFilePermissions(client, input));
  return ["drive_search_files", "drive_list_recent_files", "drive_get_file_metadata", "drive_get_file_permissions"];
}

export async function searchFiles(client, input = {}) {
  const query = buildFileQuery(input);
  return listFiles(client, input, {q: query});
}

export async function listRecentFiles(client, input = {}) {
  return listFiles(client, input, {q: "trashed = false", orderBy: "modifiedTime desc"});
}

export async function getFileMetadata(client, input = {}) {
  const fileId = pathSegment(input.fileId, "fileId");
  const result = await client.request(`${DRIVE_API}/files/${fileId}?${queryParams(sharedParams(input, {fields: FILE_FIELDS.replace("nextPageToken,", "")}))}`);
  return {file: compactFile(result)};
}

export async function getFilePermissions(client, input = {}) {
  const fileId = pathSegment(input.fileId, "fileId");
  const result = await client.paginate((params) => client.request(`${DRIVE_API}/files/${fileId}/permissions?${queryParams(sharedParams(input, {
    ...params,
    pageSize: boundedPageSize(input.pageSize),
    fields: PERMISSION_FIELDS,
  }))}`), {maxItems: boundedItemLimit(input.maxItems), itemsKey: "permissions"});
  return {fileId: input.fileId, permissions: result.items.map(compactPermission), pages: result.pages, truncated: result.truncated, nextPageToken: result.nextPageToken};
}

export function buildFileQuery(input = {}) {
  const predicates = [];
  if (input.nameContains) predicates.push(`name contains '${escapeDriveQueryValue(input.nameContains)}'`);
  if (input.mimeType) predicates.push(`mimeType = '${escapeDriveQueryValue(input.mimeType)}'`);
  if (input.query) predicates.push(String(input.query).trim().slice(0, 1024));
  predicates.push("trashed = false");
  return predicates.join(" and ");
}

export function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").slice(0, 256);
}

async function listFiles(client, input, extra) {
  const result = await client.paginate((params) => client.request(`${DRIVE_API}/files?${queryParams(sharedParams(input, {
    ...params,
    ...extra,
    pageSize: boundedPageSize(input.pageSize),
    fields: FILE_FIELDS,
  }))}`), {maxItems: boundedItemLimit(input.maxItems)});
  return {files: result.items.map(compactFile), pages: result.pages, truncated: result.truncated, nextPageToken: result.nextPageToken};
}

function sharedParams(input, extra = {}) {
  return {
    ...extra,
    ...(input.driveId ? {corpora: "drive", driveId: input.driveId} : {}),
    includeItemsFromAllDrives: input.includeAllDrives === true,
    supportsAllDrives: input.includeAllDrives === true,
  };
}

export function compactFile(file = {}) {
  return Object.fromEntries(["id", "name", "mimeType", "description", "modifiedTime", "createdTime", "webViewLink", "size", "parents", "driveId", "trashed", "owners"]
      .filter((key) => file[key] !== undefined).map((key) => [key, file[key]]));
}

function compactPermission(permission = {}) {
  return Object.fromEntries(["id", "type", "role", "emailAddress", "displayName", "domain", "allowFileDiscovery"]
      .filter((key) => permission[key] !== undefined).map((key) => [key, permission[key]]));
}
