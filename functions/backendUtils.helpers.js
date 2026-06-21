"use strict";

function httpError(status, publicMessage, cause) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  if (cause) error.cause = cause;
  return error;
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 256);
}

function positiveNumber(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function serialize(value) {
  if (!value || typeof value !== "object") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  return Object.entries(value).reduce((acc, [key, item]) => {
    acc[key] = serialize(item);
    return acc;
  }, {});
}

function toClientDoc(doc) {
  return {id: doc.id, ...serialize(doc.data())};
}

function sortByUpdatedAtDesc(left, right) {
  return Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "");
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === "number") return value;
  return 0;
}

function latestTimestampMillis(...values) {
  return values.reduce((latest, value) => Math.max(latest, timestampMillis(value)), 0);
}

function slugify(value) {
  return cleanName(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "workspace";
}

function normalizeStoragePrefix(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function userPath(uid) {
  return `users/${uid}`;
}

function firebaseStorageBucket() {
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}");
    return cleanName(config.storageBucket || "");
  } catch (error) {
    return "";
  }
}

function contentTypeForPath(path) {
  const extension = path.split(".").pop().toLowerCase();
  const contentTypes = {
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    py: "text/x-python; charset=utf-8",
    sh: "text/x-shellscript; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    yaml: "application/yaml; charset=utf-8",
    yml: "application/yaml; charset=utf-8",
  };
  return contentTypes[extension] || "text/plain; charset=utf-8";
}

function cleanContentType(value) {
  const contentType = String(value || "").trim();
  if (!contentType || /[\r\n\u0000-\u001f\u007f]/.test(contentType)) return "";
  return contentType.slice(0, 255);
}

function safeContentDispositionFilename(value) {
  return String(value || "download").replace(/["\\\r\n\u0000-\u001f\u007f]/g, "_").slice(0, 200) || "download";
}

function workspaceUploadBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.alloc(0);
}

function defaultPreviewStaticRoot(capabilities = {}) {
  return capabilities && capabilities.preview ? "/workspace/build" : null;
}

function normalizeServiceAccountEmail(value) {
  const email = cleanName(value).toLowerCase();
  if (!email) return "";
  if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email)) {
    throw new Error(`Invalid service account email: ${email}`);
  }
  return email;
}

function cloudRunServiceName(region, serviceId) {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "PROJECT_ID";
  return `projects/${project}/locations/${region}/services/${serviceId}`;
}

function publicGoogleError(error) {
  const message = error && error.response && error.response.data ?
    JSON.stringify(error.response.data) :
    error && error.message;
  return cleanName(message || "Cloud Run request failed.");
}

function isGoogleNotFound(error) {
  return error && (
    error.code === 404 ||
    error.status === 404 ||
    (error.response && error.response.status === 404) ||
    (error.response && error.response.data && error.response.data.error &&
      error.response.data.error.code === 404)
  );
}

module.exports = {
  cleanContentType,
  cleanName,
  cloudRunServiceName,
  contentTypeForPath,
  defaultPreviewStaticRoot,
  firebaseStorageBucket,
  httpError,
  isGoogleNotFound,
  latestTimestampMillis,
  normalizeServiceAccountEmail,
  normalizeStoragePrefix,
  positiveNumber,
  publicGoogleError,
  safeContentDispositionFilename,
  serialize,
  slugify,
  sortByUpdatedAtDesc,
  timestampMillis,
  toClientDoc,
  userPath,
  workspaceUploadBuffer,
};
