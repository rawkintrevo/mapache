"use strict";

const fs = require("fs");
const path = require("path");

const GOALS_PROTOCOL_VERSION = 1;
const MAX_COMMAND_BYTES = 64 * 1024;
const SUPPORTED_ACTIONS = Object.freeze(["start", "pause", "resume", "revise", "archive", "cancel", "focus", "unfocus", "settings"]);

function normalizeGoalsEnvelope(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw goalError("invalid_goal_command");
  const protocolVersion = Number(payload.protocolVersion || GOALS_PROTOCOL_VERSION);
  if (protocolVersion !== GOALS_PROTOCOL_VERSION) throw goalError("goal_protocol_unsupported");
  const type = String(payload.type || "").trim();
  if (!["command", "answer"].includes(type)) throw goalError("invalid_goal_command");
  const operationId = String(payload.operationId || "").trim();
  if (!operationId || operationId.length > 128) throw goalError("invalid_goal_operation");
  const goalId = String(payload.goalId || "").trim();
  if (!goalId || goalId.length > 256 || goalId.includes("/")) throw goalError("invalid_goal_id");
  if (type === "command") {
    const action = String(payload.action || "").trim().toLowerCase();
    if (!SUPPORTED_ACTIONS.includes(action)) throw goalError("invalid_goal_action");
    return {protocolVersion, type, operationId, goalId, action, payload: boundedObject(payload.payload)};
  }
  const questionId = String(payload.questionId || "").trim();
  const requestId = String(payload.requestId || "").trim();
  const answer = String(payload.answer || "").trim();
  if (!questionId || questionId.length > 256 || questionId.includes("/") || !requestId || requestId.length > 256 || !answer || answer.length > 16000) throw goalError("invalid_goal_answer");
  const expectedRevision = Number(payload.expectedRevision ?? 0);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw goalError("invalid_goal_revision");
  return {protocolVersion, type, operationId, goalId, questionId, requestId, answer, expectedRevision};
}

function boundedObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw goalError("invalid_goal_payload");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_COMMAND_BYTES) throw goalError("goal_payload_too_large");
  return value;
}

function createGoalsBridgeService({config = {}, terminalSession, fsModule = fs, rpcService} = {}) {
  const enabled = String(process.env.GOAL_BRIDGE_ENABLED || "").toLowerCase() === "true" &&
    String(config.harnessId || config.terminalKind || "").toLowerCase() === "pi";
  const goalsDirectory = path.join(config.workspaceDir || "/workspace", ".pi", "goals");
  const operations = new Map();
  let packageAvailable = true;

  return {
    capabilities() {
      return {
        ok: true,
        protocolVersion: GOALS_PROTOCOL_VERSION,
        enabled: enabled && packageAvailable,
        extension: process.env.PI_GOAL_X_VERSION || "",
        actions: enabled && packageAvailable ? [...SUPPORTED_ACTIONS] : [],
        structuredDialogs: Boolean(enabled && packageAvailable && rpcService?.supported),
        transport: rpcService?.supported ? "pi-rpc" : "terminal",
        reason: !enabled ? "goal_bridge_disabled" : !packageAvailable ? "managed_package_missing" : rpcService?.supported ? "pi_rpc_adapter" : "terminal_mode_adapter",
        rpc: rpcService?.capabilities?.() || null,
      };
    },
    async snapshot() {
      if (!enabled || !packageAvailable) return {ok: false, error: "goal_bridge_unavailable", goals: []};
      const goals = await readGoalFiles(fsModule, goalsDirectory);
      const rpc = rpcService?.snapshot ? await rpcService.snapshot() : null;
      return {ok: true, protocolVersion: GOALS_PROTOCOL_VERSION, goals, runtime: rpc};
    },
    async command(payload) {
      const command = normalizeGoalsEnvelope(payload);
      if (!enabled || !packageAvailable) throw goalError("goal_bridge_unavailable");
      if (rpcService?.supported) return rpcService.command(command);
      if (!terminalSession || typeof terminalSession.writePrompt !== "function") throw goalError("goal_bridge_unavailable");
      if (command.type === "answer") throw goalError("goal_structured_dialogs_unavailable");
      const prompt = promptForCommand(command);
      if (!prompt) throw goalError("goal_action_unsupported");
      terminalSession.writePrompt(prompt);
      const result = {ok: true, accepted: true, operationId: command.operationId, goalId: command.goalId, action: command.action, structuredDialogs: false};
      operations.set(command.operationId, {status: "accepted", ...result});
      while (operations.size > 256) operations.delete(operations.keys().next().value);
      return result;
    },
    setPackageAvailable(value) {
      packageAvailable = Boolean(value);
    },
    operation(operationId) {
      const cleanId = String(operationId || "").trim();
      return rpcService?.operation?.(cleanId) || operations.get(cleanId) || null;
    },
    async stop() {
      await rpcService?.stop?.();
    },
  };
}

async function readGoalFiles(fileSystem, directory) {
  const promises = fileSystem.promises || fileSystem;
  let entries;
  try {
    entries = await promises.readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const goals = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("active_goal_") || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(directory, entry.name);
    const content = await promises.readFile(filePath, "utf8");
    goals.push({path: `.pi/goals/${entry.name}`, content: String(content).slice(0, 128 * 1024)});
  }
  return goals.sort((a, b) => a.path.localeCompare(b.path));
}

function promptForCommand(command, options = {}) {
  const payload = command.payload || {};
  if (command.action === "start") {
    const objective = String(payload.objective || "").trim();
    if (!objective) throw goalError("invalid_goal_objective");
    const direct = options.guided !== true;
    return `${payload.mode === "sisyphus" ? (direct ? "/sisyphus-direct " : "/sisyphus ") : (direct ? "/goal-direct " : "/goal ")}${safePromptText(objective)}`;
  }
  if (command.action === "pause") return "/goal-pause";
  if (command.action === "resume") return "/goal-resume";
  if (command.action === "archive" || command.action === "cancel") return "/goal-clear";
  if (command.action === "focus") return "/goal-focus";
  if (command.action === "unfocus") return "/goal-unfocus";
  if (command.action === "settings") return "/goal-settings";
  if (command.action === "revise") {
    const change = String(payload.objective || "").trim();
    if (!change) throw goalError("invalid_goal_objective");
    return `/goal-tweak ${safePromptText(change)}`;
  }
  return "";
}

function safePromptText(value) {
  const text = String(value || "").trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/.test(text)) throw goalError("invalid_goal_objective");
  return text.replace(/\s+/g, " ");
}

function goalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  GOALS_PROTOCOL_VERSION,
  MAX_COMMAND_BYTES,
  SUPPORTED_ACTIONS,
  createGoalsBridgeService,
  normalizeGoalsEnvelope,
  promptForCommand,
  readGoalFiles,
};
