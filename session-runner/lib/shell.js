"use strict";

const path = require("path");
const crypto = require("node:crypto");
const pty = require("node-pty");
const {WebSocket} = require("ws");
const {createWorkspaceProcessEnvironment} = require("./runnerEnvironment");
const {prepareSshMaterial, sshCommand} = require("./sshSession");

/**
 * Owns the second, user-controlled shell for a runner session. The agent
 * terminal has a separate PTY, so opening this shell never writes into or
 * interrupts the agent process.
 */
function createShellSession({admin, config, activity, controlManager, webFirstEnabled = false} = {}) {
  const sockets = new Set();
  const socketContexts = new Map();
  let term = null;
  let outputBuffer = "";

  return {
    controlManager,
    isRunning() {
      return Boolean(term);
    },
    attach(socket, replayOutput = true) {
      const activeTerm = ensureTerm();
      if (webFirstEnabled && controlManager) socketContexts.set(socket, {
        connectionId: `shell-${crypto.randomUUID()}`,
        clientId: "",
        resumptionSecret: "",
        bound: false,
      });
      sockets.add(socket);
      updateActivity("lastConnectedAt");
      if (replayOutput && outputBuffer) sendMessage(socket, {type: "data", data: outputBuffer});
      return activeTerm;
    },
    detach(socket) {
      sockets.delete(socket);
      const context = socketContexts.get(socket);
      if (context) {
        controlManager.disconnect(context.connectionId);
        socketContexts.delete(socket);
      }
      updateActivity("lastDisconnectedAt");
    },
    handleMessage(raw, socket) {
      if (webFirstEnabled && controlManager) {
        handleControlledMessage(socket, raw);
        return;
      }
      handleMessage(activeTermOrThrow(), raw);
      markActivity();
    },
  };

  function handleControlledMessage(socket, raw) {
    const context = socketContexts.get(socket);
    if (!context) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendMessage(socket, {type: "control_error", code: "invalid_message"});
      return;
    }
    try {
      if (message.type === "control_hello") {
        const binding = controlManager.bindConnection({
          clientId: message.clientId,
          resumptionSecret: message.resumptionSecret,
          connectionId: context.connectionId,
          surface: "shell",
        });
        context.clientId = binding.clientId;
        context.resumptionSecret = binding.resumptionSecret;
        context.bound = true;
        sendMessage(socket, {type: "control_status", ...binding});
        return;
      }
      if (!context.bound) throw shellControlError("control_hello_required");
      if (message.type === "control_heartbeat") {
        sendMessage(socket, {type: "control_status", ...controlManager.heartbeat({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
          expectedControlEpoch: message.controlEpoch,
        })});
        return;
      }
      if (message.type === "control_acquire") {
        sendMessage(socket, {type: "control_status", ...controlManager.acquire({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
          surface: "shell",
        })});
        return;
      }
      if (message.type === "control_release") {
        sendMessage(socket, {type: "control_status", ...controlManager.releaseControl({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
        })});
        return;
      }
      if (!["data", "resize"].includes(message.type)) throw shellControlError("invalid_shell_message");
      if (message.type === "data") {
        sendMessage(socket, {type: "control_status", ...controlManager.acquire({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
          surface: "shell",
        })});
      }
      controlManager.assertCanWrite({
        clientId: context.clientId,
        resumptionSecret: context.resumptionSecret,
        connectionId: context.connectionId,
        expectedControlEpoch: message.controlEpoch,
      });
      handleMessage(activeTermOrThrow(), raw);
      if (message.type === "data") markActivity();
    } catch (error) {
      sendMessage(socket, {type: "control_error", code: String(error.code || "control_required")});
    }
  }

  function activeTermOrThrow() {
    if (term) return term;
    return ensureTerm();
  }

  function ensureTerm() {
    if (term) return term;
    outputBuffer = "";
    const command = shellCommand(config);
    term = spawnShell(command, config);
    activity?.appendHistory?.("shell", `opened ${command.display}`);

    term.onData((data) => {
      outputBuffer = `${outputBuffer}${data}`.slice(-Number(config.terminalReplayLimit || 256 * 1024));
      broadcast({type: "data", data});
      activity?.appendHistory?.("shell_stdout", data);
      markActivity();
    });
    term.onExit(({exitCode}) => {
      activity?.appendHistory?.("shell", `closed with exit code ${exitCode}`);
      broadcast({type: "exit", exitCode});
      closeSockets();
      term = null;
    });
    return term;
  }

  function broadcast(message) {
    for (const socket of sockets) sendMessage(socket, message);
  }

  function closeSockets() {
    for (const socket of sockets) socket.close();
  }

  function updateActivity(timestampField) {
    activity?.updateSessionActivity?.({
      [timestampField]: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  function markActivity() {
    activity?.updateSessionActivity?.({
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

function shellCommand(config = {}) {
  if (String(config.harnessId || config.terminalKind || "").trim().toLowerCase() === "ssh") {
    prepareSshMaterial(config);
    return sshCommand(config, {tty: true, loginShell: true});
  }
  const shell = process.env.SHELL || "bash";
  return {file: shell, args: ["-l"], display: `${shell} -l`};
}

function spawnShell(command, config) {
  return pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: 100,
    rows: 32,
    cwd: config.workspaceDir,
    env: {
      ...createWorkspaceProcessEnvironment(config),
      MAPACHE_RUNNER_URL: `http://127.0.0.1:${config.port}`,
      MAPACHE_PREVIEW_URL: `http://127.0.0.1:${config.port}${config.previewBasePath}/`,
      MAPACHE_QA_DIR: path.join(config.workspaceDir, ".mapache", "qa"),
      TERM: "xterm-256color",
    },
  });
}

function handleMessage(term, raw) {
  try {
    const message = JSON.parse(raw.toString());
    if (message.type === "resize") {
      term.resize(Number(message.cols || 100), Number(message.rows || 32));
      return;
    }
    if (message.type === "data") {
      term.write(String(message.data || ""));
    }
  } catch {
    term.write(raw.toString());
  }
}

function sendMessage(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function shellControlError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  createShellSession,
  shellCommand,
};
