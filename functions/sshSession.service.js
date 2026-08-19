"use strict";

const {httpError} = require("./backendUtils.helpers");

function createSshSessionService(dependencies = {}) {
  return {
    closeSshSessionForward: (uid, workspaceId, sessionId, port) =>
      closeSshSessionForward(uid, workspaceId, sessionId, port, dependencies),
    createSshSessionForward: (uid, workspaceId, sessionId, payload) =>
      createSshSessionForward(uid, workspaceId, sessionId, payload, dependencies),
    listSshSessionFiles: (uid, workspaceId, sessionId, directoryPath = "") =>
      listSshSessionFiles(uid, workspaceId, sessionId, directoryPath, dependencies),
    listSshSessionForwards: (uid, workspaceId, sessionId) =>
      listSshSessionForwards(uid, workspaceId, sessionId, dependencies),
    readSshSessionFile: (uid, workspaceId, sessionId, filePath) =>
      readSshSessionFile(uid, workspaceId, sessionId, filePath, dependencies),
    saveSshSessionFile: (uid, workspaceId, sessionId, filePath, payload) =>
      saveSshSessionFile(uid, workspaceId, sessionId, filePath, payload, dependencies),
  };
}

async function listSshSessionFiles(uid, workspaceId, sessionId, directoryPath, dependencies = {}) {
  const session = await requireRunningSshSession(uid, workspaceId, sessionId, dependencies);
  return dependencies.requestRunnerJson(session, `/ssh/files?path=${encodeURIComponent(String(directoryPath || ""))}`, {
    unavailableError: "runner_ssh_files_unavailable",
  });
}

async function readSshSessionFile(uid, workspaceId, sessionId, filePath, dependencies = {}) {
  const session = await requireRunningSshSession(uid, workspaceId, sessionId, dependencies);
  return dependencies.requestRunnerJson(session, `/ssh/file?path=${encodeURIComponent(String(filePath || ""))}`, {
    unavailableError: "runner_ssh_file_unavailable",
  });
}

async function saveSshSessionFile(uid, workspaceId, sessionId, filePath, payload, dependencies = {}) {
  const session = await requireRunningSshSession(uid, workspaceId, sessionId, dependencies);
  return dependencies.requestRunnerJson(session, `/ssh/file?path=${encodeURIComponent(String(filePath || ""))}`, {
    method: "PUT",
    body: {content: String(payload && payload.content || "")},
    unavailableError: "runner_ssh_file_save_unavailable",
  });
}

async function listSshSessionForwards(uid, workspaceId, sessionId, dependencies = {}) {
  const session = await requireRunningSshSession(uid, workspaceId, sessionId, dependencies);
  return dependencies.requestRunnerJson(session, "/ssh/ports", {
    unavailableError: "runner_ssh_ports_unavailable",
  });
}

async function createSshSessionForward(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const session = await requireRunningSshSession(uid, workspaceId, sessionId, dependencies);
  return dependencies.requestRunnerJson(session, "/ssh/ports", {
    method: "POST",
    body: {port: payload && payload.port},
    unavailableError: "runner_ssh_port_unavailable",
  });
}

async function closeSshSessionForward(uid, workspaceId, sessionId, port, dependencies = {}) {
  const session = await requireRunningSshSession(uid, workspaceId, sessionId, dependencies);
  return dependencies.requestRunnerJson(session, `/ssh/ports/${encodeURIComponent(String(port || ""))}`, {
    method: "DELETE",
    unavailableError: "runner_ssh_port_close_unavailable",
  });
}

async function requireRunningSshSession(uid, workspaceId, sessionId, dependencies = {}) {
  const {sessionSnap} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (session.sessionType !== "ssh" && session.terminalKind !== "ssh") {
    throw httpError(400, "ssh_session_required");
  }
  if (!session.serviceUrl || !session.shutdownToken) throw httpError(409, "session_not_running");
  return session;
}

module.exports = {createSshSessionService};
