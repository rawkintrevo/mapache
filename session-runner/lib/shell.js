"use strict";

const path = require("path");
const pty = require("node-pty");
const {WebSocket} = require("ws");
const {createWorkspaceProcessEnvironment} = require("./runnerEnvironment");

/**
 * Owns the second, user-controlled shell for a runner session. The agent
 * terminal has a separate PTY, so opening this shell never writes into or
 * interrupts the agent process.
 */
function createShellSession({admin, config, activity} = {}) {
  const sockets = new Set();
  let term = null;
  let outputBuffer = "";

  return {
    isRunning() {
      return Boolean(term);
    },
    attach(socket, replayOutput = true) {
      const activeTerm = ensureTerm();
      sockets.add(socket);
      updateActivity("lastConnectedAt");
      if (replayOutput && outputBuffer) sendMessage(socket, {type: "data", data: outputBuffer});
      return activeTerm;
    },
    detach(socket) {
      sockets.delete(socket);
      updateActivity("lastDisconnectedAt");
    },
    handleMessage(raw) {
      handleMessage(activeTermOrThrow(), raw);
      markActivity();
    },
  };

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

module.exports = {
  createShellSession,
  shellCommand,
};
