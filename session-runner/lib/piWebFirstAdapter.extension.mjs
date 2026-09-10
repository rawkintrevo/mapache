import net from "node:net";
import fs from "node:fs";

const ADAPTER_PROTOCOL = "mapache-pi-web-first/1";
const ADAPTER_REVISION = process.env.MAPACHE_PI_WEB_FIRST_ADAPTER_REVISION || "gate-a-0.1.0";
const MAX_LINE_BYTES = 256 * 1024;
const MAX_EVENT_TEXT = 16_000;

/**
 * Image-owned Gate A candidate bridge.
 *
 * Pi's public TUI extension API is intentionally used as-is here. The bridge
 * reports the operations that are not supported by that API instead of
 * simulating them with terminal input or undocumented runtime mutation.
 */
export default function piWebFirstAdapter(pi) {
  const socketPath = String(process.env.MAPACHE_PI_WEB_FIRST_SOCKET || "").trim();
  if (!socketPath) return;

  let server;
  let currentContext;
  let sessionGeneration = 0;
  let currentPiSession = "";
  let activeRoot = null;
  const clients = new Set();

  pi.on("session_start", async (event, ctx) => {
    currentContext = ctx;
    currentPiSession = String(ctx.sessionManager.getSessionId());
    sessionGeneration += 1;
    await openServer();
    broadcast({
      type: "event",
      event: "session_start",
      reason: event.reason,
      sessionGeneration,
      piSession: currentPiSession,
    });
  });

  pi.on("session_shutdown", async (event) => {
    broadcast({type: "event", event: "session_shutdown", reason: event.reason, sessionGeneration});
    currentContext = undefined;
    activeRoot = null;
    await closeServer();
  });

  for (const eventName of [
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ]) {
    pi.on(eventName, async (event, ctx) => {
      currentContext = ctx;
      const rootRequestId = activeRoot && shouldAttributeEvent(event) ? activeRoot.id : null;
      broadcast({
        type: "event",
        event: eventName,
        rootRequestId,
        sessionGeneration,
        piSession: currentPiSession,
        summary: summarizeEvent(event),
      });
      if (eventName === "agent_settled" && rootRequestId) activeRoot = null;
    });
  }

  pi.on("input", async (event, ctx) => {
    currentContext = ctx;
    const rootRequestId = event.source === "extension" && activeRoot ? activeRoot.id : null;
    broadcast({
      type: "event",
      event: "input",
      source: event.source,
      rootRequestId,
      sessionGeneration,
      piSession: currentPiSession,
      summary: {textLength: String(event.text || "").length},
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    currentContext = ctx;
    broadcast({
      type: "event",
      event: "tool_call",
      rootRequestId: activeRoot ? activeRoot.id : null,
      sessionGeneration,
      piSession: currentPiSession,
      summary: {toolCallId: event.toolCallId, toolName: event.toolName},
    });
  });

  async function openServer() {
    if (server) return;
    try { fs.unlinkSync(socketPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket._mapacheBuffer = "";
      clients.add(socket);
      socket.once("close", () => clients.delete(socket));
      socket.once("error", () => clients.delete(socket));
      send(socket, handshake());
      socket.on("data", (chunk) => readRequests(socket, chunk));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch {}
        resolve();
      });
    });
  }

  async function closeServer() {
    const current = server;
    server = undefined;
    for (const socket of clients) socket.destroy();
    clients.clear();
    if (!current) return;
    await new Promise((resolve) => current.close(() => resolve()));
    try { fs.unlinkSync(socketPath); } catch {}
  }

  function readRequests(socket, chunk) {
    socket._mapacheBuffer += String(chunk || "");
    if (Buffer.byteLength(socket._mapacheBuffer, "utf8") > MAX_LINE_BYTES * 2) {
      socket._mapacheBuffer = socket._mapacheBuffer.slice(-MAX_LINE_BYTES);
    }
    let newline;
    while ((newline = socket._mapacheBuffer.indexOf("\n")) >= 0) {
      const line = socket._mapacheBuffer.slice(0, newline).replace(/\r$/, "");
      socket._mapacheBuffer = socket._mapacheBuffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) continue;
      let message;
      try { message = JSON.parse(line); } catch { send(socket, response("", false, "web_first_adapter_invalid_json")); continue; }
      void handleRequest(socket, message);
    }
  }

  async function handleRequest(socket, message) {
    const id = String(message.id || "");
    if (message.type !== "request" || !id) return;
    if (message.expectedSessionGeneration !== undefined && message.expectedSessionGeneration !== sessionGeneration) {
      send(socket, response(id, false, "web_first_adapter_stale_generation"));
      return;
    }
    try {
      const result = await dispatch(message.operation, message.payload || {}, id);
      send(socket, response(id, true, undefined, result));
    } catch (error) {
      send(socket, response(id, false, error?.code || String(error?.message || error)));
    }
  }

  async function dispatch(operation, payload, requestId) {
    if (!currentContext) throw bridgeError("web_first_adapter_session_not_ready");
    if (operation === "handshake") return handshake();
    if (operation === "prompt") {
      const message = String(payload.message || "").trim();
      if (!message) throw bridgeError("web_first_adapter_prompt_empty");
      if (message.startsWith("/")) throw bridgeError("web_first_adapter_command_expansion_unsupported");
      if (activeRoot) throw bridgeError("web_first_adapter_operation_in_progress");
      activeRoot = {id: requestId, startedAt: Date.now()};
      // The public TUI API starts the same Pi process and does not write PTY
      // bytes. It returns void, so completion is represented only by causal
      // lifecycle events.
      pi.sendUserMessage(message);
      return {accepted: true, transport: "tui-extension", rootRequestId: requestId};
    }
    if (operation === "cancel") {
      if (!activeRoot) return {accepted: false, reason: "no_active_root"};
      currentContext.abort();
      return {accepted: true, rootRequestId: activeRoot.id};
    }
    if (operation === "extension_command") throw bridgeError("web_first_adapter_command_expansion_unsupported");
    if (operation === "dialog_answer") throw bridgeError("web_first_adapter_tui_dialog_response_unsupported");
    if (operation === "reload") throw bridgeError("web_first_adapter_reload_requires_command_context");
    if (operation === "replace_session") throw bridgeError("web_first_adapter_session_replacement_requires_command_context");
    throw bridgeError("web_first_adapter_operation_unsupported");
  }

  function handshake() {
    return {
      type: "handshake",
      protocol: ADAPTER_PROTOCOL,
      runtime: "pi-tui-extension",
      pid: process.pid,
      sessionGeneration,
      piSession: currentPiSession,
      adapter: ADAPTER_REVISION,
      package: {
        name: "pi-goal-x",
        version: String(process.env.PI_GOAL_X_VERSION || "unknown"),
      },
    };
  }

  function broadcast(message) {
    for (const socket of clients) send(socket, message);
  }

  function send(socket, message) {
    if (!socket || socket.destroyed) return;
    socket.write(`${JSON.stringify(message)}\n`);
  }

  function response(id, success, error, result) {
    return {type: "response", id, success, ...(error ? {error} : {}), ...(result === undefined ? {} : {result})};
  }

  function shouldAttributeEvent(event) {
    return event?.type === "agent_start" || event?.type === "agent_end" || event?.type === "agent_settled" ||
      event?.type === "turn_start" || event?.type === "turn_end" || event?.type?.startsWith("message_") ||
      event?.type?.startsWith("tool_execution_");
  }
}

function summarizeEvent(event) {
  const summary = {};
  for (const key of ["toolCallId", "toolName", "turnIndex", "isError", "stopReason", "willRetry"]) {
    if (event?.[key] !== undefined) summary[key] = event[key];
  }
  if (event?.message?.role) summary.role = event.message.role;
  if (event?.message?.stopReason) summary.stopReason = event.message.stopReason;
  return summary;
}

function bridgeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
