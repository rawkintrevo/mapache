"use strict";

const {sessionHarnessId} = require("./agentAuth.service");
const {
  httpError,
} = require("./backendUtils.helpers");

function createPiService(dependencies = {}) {
  return {
    deleteWorkspaceSubagent: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies),
    deleteWorkspaceSkill: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    deletePiSkill: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    listWorkspaceSubagents: (uid, workspaceId, sessionId) =>
      listWorkspaceSubagents(uid, workspaceId, sessionId, dependencies),
    listWorkspaceSkills: (uid, workspaceId, sessionId) =>
      listWorkspaceSkills(uid, workspaceId, sessionId, dependencies),
    listPiSkills: (uid, workspaceId, sessionId) =>
      listWorkspaceSkills(uid, workspaceId, sessionId, dependencies),
    saveWorkspaceSubagent: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies),
    saveWorkspaceSkill: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    savePiSkill: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
  };
}

async function listWorkspaceSkills(uid, workspaceId, sessionId, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSkills(session)) throw httpError(501, "runner_skill_listing_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_listing_unsupported");
  return requestRunnerWorkspaceSkills(session, dependencies);
}

async function saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skill = normalizePiSkillPayload(payload);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSkills(session)) throw httpError(501, "runner_skill_save_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_save_unsupported");
  return requestRunnerWorkspaceSkillSave(session, skill, dependencies);
}

async function deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skillName = normalizePiSkillName(payload.name);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSkills(session)) throw httpError(501, "runner_skill_delete_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_delete_unsupported");
  return requestRunnerWorkspaceSkillDelete(session, {name: skillName}, dependencies);
}

async function listWorkspaceSubagents(uid, workspaceId, sessionId, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSubagents(session)) throw httpError(501, "runner_subagent_listing_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_subagent_listing_unsupported");
  return requestRunnerWorkspaceSubagents(session, dependencies);
}

async function saveWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const subagent = normalizeWorkspaceSubagentPayload(payload);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSubagents(session)) throw httpError(501, "runner_subagent_save_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_subagent_save_unsupported");
  return requestRunnerWorkspaceSubagentSave(session, subagent, dependencies);
}

async function deleteWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const subagentName = normalizeWorkspaceSubagentName(payload.name);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSubagents(session)) throw httpError(501, "runner_subagent_delete_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_subagent_delete_unsupported");
  return requestRunnerWorkspaceSubagentDelete(session, {name: subagentName}, dependencies);
}

async function requestRunnerWorkspaceSkills(session, dependencies = {}) {
  return requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
    legacyRoutePath: "/pi/skills",
    routePath: "/skills",
    requestOptions: {
      notFoundError: "runner_skill_listing_unsupported",
      notFoundStatus: 501,
      failureError: "pi_skill_list_failed",
      unavailableError: "runner_skill_list_unavailable",
    },
  });
}

async function requestRunnerWorkspaceSkillSave(session, body, dependencies = {}) {
  return requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
    legacyRoutePath: "/pi/skills",
    routePath: "/skills",
    requestOptions: {
      method: "POST",
      body,
      notFoundError: "runner_skill_save_unsupported",
      notFoundStatus: 501,
      failureError: "pi_skill_save_failed",
      unavailableError: "runner_skill_save_unavailable",
      timeoutMs: 30000,
    },
  });
}

async function requestRunnerWorkspaceSkillDelete(session, body, dependencies = {}) {
  return requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
    legacyRoutePath: "/pi/skills/delete",
    routePath: "/skills/delete",
    requestOptions: {
      method: "POST",
      body,
      notFoundError: "runner_skill_delete_unsupported",
      notFoundStatus: 501,
      failureError: "pi_skill_delete_failed",
      unavailableError: "runner_skill_delete_unavailable",
      timeoutMs: 30000,
    },
  });
}

async function requestRunnerWorkspaceSubagents(session, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/subagents", {
    notFoundError: "runner_subagent_listing_unsupported",
    notFoundStatus: 501,
    failureError: "subagent_list_failed",
    unavailableError: "runner_subagent_list_unavailable",
  });
}

async function requestRunnerWorkspaceSubagentSave(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/subagents", {
    method: "POST",
    body,
    notFoundError: "runner_subagent_save_unsupported",
    notFoundStatus: 501,
    failureError: "subagent_save_failed",
    unavailableError: "runner_subagent_save_unavailable",
    timeoutMs: 30000,
  });
}

async function requestRunnerWorkspaceSubagentDelete(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/subagents/delete", {
    method: "POST",
    body,
    notFoundError: "runner_subagent_delete_unsupported",
    notFoundStatus: 501,
    failureError: "subagent_delete_failed",
    unavailableError: "runner_subagent_delete_unavailable",
    timeoutMs: 30000,
  });
}

function sessionSupportsWorkspaceSkills(session = {}) {
  return ["pi", "codex"].includes(sessionHarnessId(session));
}

function sessionSupportsWorkspaceSubagents(session = {}) {
  return ["pi", "codex"].includes(sessionHarnessId(session));
}

async function requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
  routePath,
  legacyRoutePath,
  requestOptions,
}) {
  try {
    return await requestRunnerJsonDependency(dependencies, session, routePath, requestOptions);
  } catch (error) {
    if (error?.status !== (requestOptions.notFoundStatus || 501) || error?.publicMessage !== requestOptions.notFoundError) {
      throw error;
    }
    return requestRunnerJsonDependency(dependencies, session, legacyRoutePath, requestOptions);
  }
}

function normalizePiSkillPayload(payload) {
  return {
    name: normalizePiSkillName(payload && payload.name),
    description: normalizePiSkillDescription(payload && payload.description),
    content: normalizePiSkillContent(payload && (payload.content || payload.instructions)),
  };
}

function normalizePiSkillName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw httpError(400, "invalid_skill_name");
  }
  return name;
}

function normalizePiSkillDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw httpError(400, "invalid_skill_description");
  }
  return description;
}

function normalizePiSkillContent(value) {
  const content = String(value || "").trim();
  if (!content || content.length > 128 * 1024 || /\u0000/.test(content)) {
    throw httpError(400, "invalid_skill_content");
  }
  return content;
}

function normalizeWorkspaceSubagentPayload(payload) {
  return {
    name: normalizeWorkspaceSubagentName(payload && payload.name),
    description: normalizeWorkspaceSubagentDescription(payload && payload.description),
    instructions: normalizeWorkspaceSubagentInstructions(payload && (payload.instructions || payload.content || payload.developerInstructions)),
  };
}

function normalizeWorkspaceSubagentName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw httpError(400, "invalid_subagent_name");
  }
  return name;
}

function normalizeWorkspaceSubagentDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw httpError(400, "invalid_subagent_description");
  }
  return description;
}

function normalizeWorkspaceSubagentInstructions(value) {
  const instructions = String(value || "").trim();
  if (!instructions || instructions.length > 128 * 1024 || /\u0000/.test(instructions)) {
    throw httpError(400, "invalid_subagent_content");
  }
  return instructions;
}

async function requireWorkspaceDependency(dependencies, uid, workspaceId) {
  if (typeof dependencies.requireWorkspace !== "function") {
    throw new Error("Pi service requires a requireWorkspace dependency.");
  }
  return dependencies.requireWorkspace(uid, workspaceId);
}

async function requireSessionDependency(dependencies, uid, workspaceId, sessionId) {
  if (typeof dependencies.requireSession !== "function") {
    throw new Error("Pi service requires a requireSession dependency.");
  }
  return dependencies.requireSession(uid, workspaceId, sessionId);
}

async function requestRunnerJsonDependency(dependencies, session, routePath, options = {}) {
  if (typeof dependencies.requestRunnerJson !== "function") {
    throw new Error("Pi service requires a requestRunnerJson dependency.");
  }
  return dependencies.requestRunnerJson(session, routePath, options);
}

module.exports = {
  createPiService,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  normalizePiSkillPayload,
  sessionSupportsWorkspaceSkills,
  sessionSupportsWorkspaceSubagents,
};
