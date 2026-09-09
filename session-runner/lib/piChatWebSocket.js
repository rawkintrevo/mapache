"use strict";

const {WebSocketServer, WebSocket} = require("ws");

const MAX_PROMPT_BYTES = 64 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function createPiChatWebSocket({
  config = {},
  hasBrowserAccess,
  terminalSession,
  transcriptService,
  WebSocketServerClass = WebSocketServer,
} = {}) {
  if (!terminalSession || typeof terminalSession.writePrompt !== "function") {
    throw new Error("Pi Chat WebSocket requires a terminal prompt bridge.");
  }
  if (!transcriptService || typeof transcriptService.subscribe !== "function") {
    throw new Error("Pi Chat WebSocket requires a transcript service.");
  }

  const supported = isSupported(config);
  const sockets = new Set();
  const server = new WebSocketServerClass({noServer: true});

  server.on("connection", (socket, request) => {
    if (!supported || typeof hasBrowserAccess !== "function" || !hasBrowserAccess(request)) {
      socket.close(1008, "unauthorized");
      return;
    }

    sockets.add(socket);
    const unsubscribe = transcriptService.subscribe((event) => sendTranscriptEvent(socket, event));
    socket.on("message", (raw) => {
      void handleClientMessage(socket, raw);
    });
    socket.once("close", () => {
      sockets.delete(socket);
      unsubscribe();
    });
    socket.on("error", () => {});
  });

  return {
    server,
    supported,
    close() {
      for (const socket of sockets) socket.close(1001, "runner_shutdown");
      sockets.clear();
      transcriptService.stop?.();
      server.close();
    },
  };

  async function handleClientMessage(socket, raw) {
    const message = parseClientMessage(raw);
    if (!message.ok) {
      sendError(socket, message.code);
      return;
    }

    try {
      terminalSession.writePrompt(message.text);
    } catch (error) {
      sendError(socket, "prompt_failed");
      return;
    }
    send(socket, {type: "prompt_ack", clientId: message.clientId});
    send(socket, {type: "status", status: "working"});
  }
}

function isSupported(config) {
  return String(config.harnessId || "").trim().toLowerCase() === "pi" && Boolean(config.runnerCapabilities?.chat);
}

function parseClientMessage(raw) {
  let message;
  try {
    message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch (error) {
    return {ok: false, code: "invalid_message"};
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || message.type !== "prompt") {
    return {ok: false, code: "invalid_message"};
  }
  const clientId = typeof message.clientId === "string" ? message.clientId.trim() : "";
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!clientId || !text || CONTROL_CHARACTER_PATTERN.test(clientId) || CONTROL_CHARACTER_PATTERN.test(text)) {
    return {ok: false, code: "invalid_prompt"};
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) return {ok: false, code: "prompt_too_large"};
  return {ok: true, clientId, text};
}

function sendTranscriptEvent(socket, event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "snapshot" || event.type === "reset") {
    send(socket, {type: event.type, messages: safeMessages(event.messages)});
    return;
  }
  if (event.type === "message" && event.message) {
    send(socket, {type: "message", message: safeMessage(event.message)});
    return;
  }
  if (event.type === "status" && ["waiting_for_transcript", "working", "ready"].includes(event.status)) {
    send(socket, {type: "status", status: event.status});
  }
}

function safeMessages(messages) {
  return Array.isArray(messages) ? messages.map(safeMessage).filter(Boolean) : [];
}

function safeMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (!(["user", "assistant"].includes(message.role) && typeof message.id === "string" &&
    typeof message.markdown === "string")) return null;
  return {
    id: message.id,
    role: message.role,
    markdown: message.markdown,
    createdAt: message.createdAt === null || message.createdAt === undefined ? null : String(message.createdAt),
  };
}

function sendError(socket, code) {
  send(socket, {type: "error", code});
}

function send(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

module.exports = {
  MAX_PROMPT_BYTES,
  createPiChatWebSocket,
  isSupported,
  parseClientMessage,
};
