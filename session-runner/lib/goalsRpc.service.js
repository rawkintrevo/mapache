"use strict";

const {EventEmitter} = require("node:events");
const {spawn: defaultSpawn} = require("node:child_process");
const {createWorkspaceProcessEnvironment} = require("./runnerEnvironment");
const {normalizeGoalsEnvelope, promptForCommand, GOALS_PROTOCOL_VERSION} = require("./goalsProtocol");
const {LEGACY_INTEGRATION_MODE} = require("./integrationMode");

const MAX_RPC_LINE_BYTES = 256 * 1024;
const MAX_PENDING_UI = 32;
const MAX_OPERATIONS = 256;
const RPC_TIMEOUT_MS = 30_000;

/**
 * Owns the headless Pi process used by managed Goals. Pi's RPC mode is the
 * supported transport for extension select/confirm/input/editor requests;
 * callers never parse terminal ANSI output to infer goal state.
 */
function createGoalsRpcService({
  config = {},
  terminalSession,
  spawn = defaultSpawn,
  env = process.env,
  timers = globalThis,
  processSupervisor,
} = {}) {
  const enabled = String(env.GOAL_RPC_ENABLED || "").toLowerCase() === "true" &&
    String(config.harnessId || config.terminalKind || "").toLowerCase() === "pi" &&
    (config.integrationMode || (config.webFirstEnabled ? "web-first" : LEGACY_INTEGRATION_MODE)) === LEGACY_INTEGRATION_MODE;
  const events = new EventEmitter();
  const pendingResponses = new Map();
  const pendingUi = new Map();
  const operations = new Map();
  let child = null;
  let stdoutBuffer = "";
  let processInstance = 0;
  let activeGoalId = "";
  let status = "stopped";
  let packageAvailable = true;
  let switching = false;
  let commandInFlight = false;
  let lastError = "";
  let lastMessage = "";
  const integrationMode = config.integrationMode || (config.webFirstEnabled ? "web-first" : LEGACY_INTEGRATION_MODE);

  return {
    supported: enabled,
    isActive: () => switching || Boolean(child),
    capabilities() {
      return {
        transport: "pi-rpc",
        integrationMode,
        enabled,
        structuredDialogs: enabled && packageAvailable,
        active: Boolean(child && !child.killed),
        status,
      };
    },
    async snapshot() {
      return {
        ok: enabled && packageAvailable,
        protocolVersion: GOALS_PROTOCOL_VERSION,
        processInstance: processInstance || null,
        active: Boolean(child && !child.killed),
        status,
        goalId: activeGoalId,
        lastError,
        lastMessage,
        pendingUiRequests: [...pendingUi.values()].map(safeUiRequest),
      };
    },
    async command(payload) {
      const command = normalizeGoalsEnvelope(payload);
      if (!enabled || !packageAvailable) throw goalError("goal_bridge_unavailable");
      if (command.type === "answer") return answerUiRequest(command);
      const previous = operations.get(command.operationId);
      if (previous) return previous;
      if (commandInFlight) throw goalError("goal_command_in_progress");
      if (child && activeGoalId && activeGoalId !== command.goalId) throw goalError("goal_execution_busy");
      // Validate before stopping a user's terminal.
      const prompt = promptForCommand(command, {guided: true});
      if (!prompt) throw goalError("goal_action_unsupported");
      commandInFlight = true;
      lastError = "";
      try {
        if (terminalSession?.isRunning?.()) {
          if (command.payload.takeOverTerminal !== true || !["start", "resume"].includes(command.action) || !terminalSession.releaseForGoal) {
            throw goalError("goal_terminal_process_active");
          }
          switching = true;
          await terminalSession.releaseForGoal();
        }
        const process = await ensureProcess();
        switching = false;
        activeGoalId = command.goalId;
        const response = await send(process, {type: "prompt", message: prompt}, {acceptUi: ["start", "resume"].includes(command.action)});
        if (!response?.success) {
          lastError = String(response?.error || "goal_command_failed").slice(0, 4000);
          throw goalError("goal_command_failed");
        }
        const result = {
          ok: true,
          accepted: true,
          operationId: command.operationId,
          goalId: command.goalId,
          action: command.action,
          structuredDialogs: true,
          transport: "pi-rpc",
        };
        rememberOperation(command.operationId, {status: "accepted", ...result});
        if (["archive", "cancel"].includes(command.action)) {
          await stop();
        }
        return result;
      } finally {
        switching = false;
        commandInFlight = false;
      }
    },
    operation(operationId) {
      return operations.get(String(operationId || "").trim()) || null;
    },
    on(event, listener) {
      events.on(event, listener);
      return () => events.off(event, listener);
    },
    setPackageAvailable(value) {
      packageAvailable = Boolean(value);
    },
    stop,
  };

  async function ensureProcess() {
    if (status === "stopping") throw goalError("goal_command_in_progress");
    if (child) return child;
    const sessionArgs = [];
    if (config.piSessionDir) sessionArgs.push("--session-dir", config.piSessionDir);
    sessionArgs.push("--mode", "rpc", "-c");
    const childEnv = {
      ...createWorkspaceProcessEnvironment(config, env),
      HOME: config.homeDir || env.HOME || "/root",
      PI_CODING_AGENT_DIR: config.piAgentDir || env.PI_CODING_AGENT_DIR,
      TERM: "dumb",
      MAPACHE_GOAL_RPC: "1",
    };
    const next = spawn("pi", sessionArgs, {
      cwd: config.workspaceDir || "/workspace",
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = next;
    processSupervisor?.register?.(next, {id: "goals-rpc", label: "managed-goals"});
    processInstance += 1;
    stdoutBuffer = "";
    status = "starting";
    next.stdout?.on("data", (chunk) => parseStdout(chunk));
    next.stderr?.on("data", (chunk) => events.emit("stderr", String(chunk)));
    next.once?.("exit", (code, signal) => handleExit(next, code, signal));
    next.once?.("error", (error) => {
      lastError = "Pi could not start. Restart this session and try again.";
      handleExit(next, null, null, error);
    });
    return next;
  }

  function parseStdout(chunk) {
    stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_RPC_LINE_BYTES * 2) {
      stdoutBuffer = stdoutBuffer.slice(-MAX_RPC_LINE_BYTES);
    }
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      handleMessage(message);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "response" && message.id) {
      const pending = pendingResponses.get(String(message.id));
      if (pending) {
        pendingResponses.delete(String(message.id));
        timers.clearTimeout(pending.timer);
        if (!message.success) {
          lastError = String(message.error || "Goal command failed.").slice(0, 4000);
          status = "error";
        }
        pending.resolve(message);
      }
      return;
    }
    if (message.type === "extension_ui_request") {
      if (message.method === "notify") {
        lastMessage = String(message.message || "").slice(0, 4000);
        if (message.notifyType === "error") {
          lastError = lastMessage;
          status = "error";
        }
      }
      if (!["select", "confirm", "input", "editor"].includes(message.method)) {
        events.emit("event", safeUiRequest(message));
        return;
      }
      const request = safeUiRequest({...message, goalId: activeGoalId});
      if (pendingUi.size >= MAX_PENDING_UI) {
        writeRpc({type: "extension_ui_response", id: request.id, cancelled: true});
        return;
      }
      pendingUi.set(request.id, request);
      // Extension commands may await a dialog before emitting their prompt
      // response. Receipt of the dialog proves delivery and lets Functions
      // assign the goal so the browser can fetch and answer that dialog.
      for (const pending of pendingResponses.values()) {
        if (!pending.acceptUi) continue;
        timers.clearTimeout(pending.timer);
        pending.resolve({success: true, waitingForInput: true});
        pending.acceptUi = false;
      }
      status = "waiting_for_input";
      events.emit("ui_request", request);
      return;
    }
    if (message.type === "agent_start") status = "running";
    if (message.type === "message_end" && message.message?.role === "assistant") {
      const reply = message.message;
      if (reply.stopReason === "error" || reply.errorMessage) {
        lastError = String(reply.errorMessage || "Pi could not complete this turn. Check the session model and authentication.").slice(0, 4000);
        status = "error";
      } else {
        const text = (reply.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (text) lastMessage = text.slice(-4000);
      }
    }
    if (message.type === "agent_end" && !lastError) status = pendingUi.size ? "waiting_for_input" : "ready";
    events.emit("event", boundedRpcEvent(message));
  }

  function writeRpc(message) {
    if (!child?.stdin || child.stdin.destroyed) throw goalError("goal_bridge_unavailable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function send(process, command, {acceptUi = false} = {}) {
    const id = `mapache-goal-${processInstance}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pendingResponses.delete(id);
        reject(goalError("goal_command_timeout"));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      pendingResponses.set(id, {resolve, reject, timer, acceptUi});
      try {
        writeRpc({...command, id});
      } catch (error) {
        timers.clearTimeout(timer);
        pendingResponses.delete(id);
        reject(error);
      }
    });
  }

  async function answerUiRequest(command) {
    const request = pendingUi.get(command.requestId) || pendingUi.get(command.questionId);
    if (!request) throw goalError("goal_question_stale");
    if (request.goalId && request.goalId !== command.goalId) throw goalError("goal_question_stale");
    const response = {type: "extension_ui_response", id: request.id};
    if (request.method === "confirm") response.confirmed = /^(true|yes|y|confirm|confirmed)$/i.test(command.answer);
    else response.value = command.answer;
    writeRpc(response);
    pendingUi.delete(request.id);
    status = pendingUi.size > 0 ? "waiting_for_input" : "running";
    const result = {ok: true, accepted: true, operationId: command.operationId, goalId: command.goalId, questionId: command.questionId, structuredDialogs: true};
    rememberOperation(command.operationId, {status: "answered", ...result});
    return result;
  }

  async function stop() {
    const current = child;
    if (!current) return;
    status = "stopping";
    await new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => reject(goalError("goal_process_stop_timeout")), 5000);
      current.once("exit", () => { timers.clearTimeout(timer); resolve(); });
      try { current.kill("SIGTERM"); } catch (error) {
        timers.clearTimeout(timer);
        reject(error);
      }
    });
  }

  function handleExit(process, code, signal, error) {
    if (child !== process) return;
    const intentional = status === "stopping";
    child = null;
    activeGoalId = "";
    status = intentional ? "stopped" : "interrupted";
    if (!intentional) lastError = "Pi stopped. Restart the session, then resume the goal.";
    for (const pending of pendingResponses.values()) {
      timers.clearTimeout(pending.timer);
      pending.reject(goalError("goal_bridge_unavailable"));
    }
    pendingResponses.clear();
    pendingUi.clear();
    events.emit("exit", {code, signal, error: error ? String(error.message || error) : null});
  }

  function rememberOperation(id, result) {
    operations.set(String(id), result);
    while (operations.size > MAX_OPERATIONS) operations.delete(operations.keys().next().value);
  }
}

function safeUiRequest(message) {
  const result = {
    id: String(message.id || "").slice(0, 256),
    method: String(message.method || "").slice(0, 32),
    goalId: String(message.goalId || "").slice(0, 256),
    title: String(message.title || "").slice(0, 4000),
  };
  if (Array.isArray(message.options)) result.options = message.options.slice(0, 100).map((item) => String(item).slice(0, 2000));
  if (message.message !== undefined) result.message = String(message.message).slice(0, 16_000);
  if (message.placeholder !== undefined) result.placeholder = String(message.placeholder).slice(0, 1000);
  if (message.prefill !== undefined) result.prefill = String(message.prefill).slice(0, 16_000);
  return result;
}

function boundedRpcEvent(message) {
  const safe = {type: String(message.type || "").slice(0, 64)};
  for (const key of ["status", "toolName", "message", "error", "reason"]) {
    if (message[key] !== undefined) safe[key] = String(message[key]).slice(0, 4000);
  }
  return safe;
}

function goalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  MAX_PENDING_UI,
  MAX_RPC_LINE_BYTES,
  createGoalsRpcService,
};
