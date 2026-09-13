"use strict";

const {auth} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 500;
const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function createSessionLogsService(dependencies = {}) {
  return {
    listSessionLogs: (uid, workspaceId, sessionId, query = {}) =>
      listSessionLogs(uid, workspaceId, sessionId, query, dependencies),
  };
}

async function listSessionLogs(uid, workspaceId, sessionId, query = {}, dependencies = {}) {
  const {sessionSnap} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const session = sessionSnap.data() || {};
  const serviceId = String(session.serviceId || "").trim().toLowerCase();
  if (!SERVICE_ID_PATTERN.test(serviceId)) throw httpError(404, "session_logs_unavailable");

  const authClient = dependencies.auth || auth;
  const projectId = String(
      dependencies.projectId ||
      process.env.GCLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      await authClient.getProjectId(),
  ).trim();
  if (!projectId) throw httpError(503, "session_logs_unavailable");

  const requestedLimit = Number(query.limit);
  const pageSize = Number.isSafeInteger(requestedLimit) ?
    Math.min(MAX_LOG_LIMIT, Math.max(1, requestedLimit)) :
    DEFAULT_LOG_LIMIT;
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${serviceId}"`,
  ].join(" AND ");

  try {
    const client = await authClient.getClient();
    const response = await client.request({
      url: "https://logging.googleapis.com/v2/entries:list",
      method: "POST",
      data: {
        resourceNames: [`projects/${projectId}`],
        filter,
        orderBy: "timestamp desc",
        pageSize,
      },
    });
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    return {
      serviceId,
      logs: entries.map(toClientLogEntry).filter((entry) => entry.message),
    };
  } catch (error) {
    throw httpError(503, "session_logs_unavailable", error);
  }
}

function toClientLogEntry(entry = {}) {
  return {
    id: String(entry.insertId || `${entry.timestamp || ""}:${logMessage(entry)}`).slice(0, 512),
    timestamp: String(entry.timestamp || entry.receiveTimestamp || ""),
    severity: String(entry.severity || "DEFAULT").toUpperCase().slice(0, 32),
    message: cleanLogMessage(logMessage(entry)),
  };
}

function logMessage(entry = {}) {
  if (typeof entry.textPayload === "string") return entry.textPayload;
  if (typeof entry.jsonPayload?.message === "string") return entry.jsonPayload.message;
  if (typeof entry.protoPayload?.status?.message === "string") return entry.protoPayload.status.message;
  if (entry.httpRequest) {
    const method = String(entry.httpRequest.requestMethod || "REQUEST").toUpperCase();
    const path = safeRequestPath(entry.httpRequest.requestUrl);
    const status = Number(entry.httpRequest.status) || 0;
    return `${method} ${path}${status ? ` ${status}` : ""}`;
  }
  return "";
}

function safeRequestPath(value) {
  try {
    const url = new URL(String(value || ""));
    return url.pathname || "/";
  } catch (error) {
    return "/";
  }
}

function cleanLogMessage(value) {
  return String(value || "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .slice(0, 16_000);
}

module.exports = {
  cleanLogMessage,
  createSessionLogsService,
  logMessage,
  safeRequestPath,
  toClientLogEntry,
};
