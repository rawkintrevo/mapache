"use strict";

const path = require("path");
const pty = require("node-pty");
const {WebSocket} = require("ws");

function createTerminalSession({admin, config, activity}) {
  const sockets = new Set();
  let term = null;
  let outputBuffer = "";
  let activityTimer = null;
  let pendingActivity = null;

  return {
    attach(socket, replayOutput) {
      const activeTerm = ensureTerm();
      sockets.add(socket);
      updateSocketActivity("lastConnectedAt");
      if (replayOutput && outputBuffer) {
        sendTerminalMessage(socket, {type: "data", data: outputBuffer});
      }
      return activeTerm;
    },
    detach(socket) {
      sockets.delete(socket);
      updateSocketActivity("lastDisconnectedAt");
    },
    handleMessage(raw) {
      handleTerminalMessage(ensureTerm(), raw);
      markTerminalActivity();
    },
  };

  function ensureTerm() {
    if (term) return term;

    outputBuffer = "";

    const command = terminalCommand();
    term = spawnTerminal(command, config);

    activity.appendHistory("system", `opened ${command.display}`);

    term.onData((data) => {
      appendToBuffer(data);
      broadcast({type: "data", data});
      activity.appendHistory("stdout", data);
      markTerminalActivity();
    });

    term.onExit(({exitCode: code}) => {
      activity.appendHistory("system", `closed with exit code ${code}`);
      broadcast({type: "exit", exitCode: code});
      closeSockets();
      term = null;
    });

    return term;
  }

  function appendToBuffer(data) {
    outputBuffer += data;
    if (outputBuffer.length > config.terminalReplayLimit) {
      outputBuffer = outputBuffer.slice(outputBuffer.length - config.terminalReplayLimit);
    }
  }

  function broadcast(message) {
    for (const socket of sockets) {
      sendTerminalMessage(socket, message);
    }
  }

  function closeSockets() {
    for (const socket of sockets) {
      socket.close();
    }
  }

  function updateSocketActivity(timestampField) {
    activity.updateSessionActivity({
      activeSocketCount: sockets.size,
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      [timestampField]: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  function markTerminalActivity() {
    if (activityTimer) {
      pendingActivity = {
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      return;
    }

    activity.updateSessionActivity({
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    activityTimer = setTimeout(() => {
      activityTimer = null;
      if (!pendingActivity) return;
      const activityUpdate = pendingActivity;
      pendingActivity = null;
      activity.updateSessionActivity(activityUpdate);
    }, config.activityWriteDebounceMs);
  }
}

function shouldReplayTerminal(request) {
  try {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get("replay") !== "0";
  } catch (error) {
    return true;
  }
}

function spawnTerminal(command, config) {
  return pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: 100,
    rows: 32,
    cwd: config.workspaceDir,
    env: {
      ...process.env,
      MAPACHE_RUNNER_URL: `http://127.0.0.1:${config.port}`,
      MAPACHE_PREVIEW_URL: `http://127.0.0.1:${config.port}${config.previewBasePath}/`,
      MAPACHE_QA_DIR: path.join(config.workspaceDir, ".mapache", "qa"),
      TERM: "xterm-256color",
    },
  });
}

function handleTerminalMessage(term, raw) {
  try {
    const message = JSON.parse(raw.toString());
    if (message.type === "resize") {
      term.resize(Number(message.cols || 100), Number(message.rows || 32));
      return;
    }
    if (message.type === "data") {
      term.write(String(message.data || ""));
    }
  } catch (error) {
    term.write(raw.toString());
  }
}

function sendTerminalMessage(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function terminalCommand() {
  const command = String(process.env.TERMINAL_COMMAND || "").trim();
  if (command) {
    const args = terminalArgs();
    return {file: command, args, display: [command, ...args].join(" ")};
  }

  const shell = process.env.SHELL || "bash";
  return {file: shell, args: ["-l"], display: `${shell} -l`};
}

function terminalArgs() {
  try {
    const raw = String(process.env.TERMINAL_ARGS || "[]").trim();
    const json = raw.replace(/^'([\s\S]*)'$/, "$1");
    const value = JSON.parse(json || "[]");
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch (error) {
    console.error("invalid TERMINAL_ARGS, using no arguments", error);
    return [];
  }
}

function renderTerminalPage(options = {}) {
  const accessToken = String(options.accessToken || "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Cloud Terminal</title>
    <link rel="stylesheet" href="/xterm/css/xterm.css">
    <style>
      html, body {
        height: 100%;
        margin: 0;
        background: #0d1117;
      }
      #terminal {
        height: 100%;
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
      }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script src="/xterm/lib/xterm.js"></script>
    <script>
      const terminalElement = document.getElementById("terminal");
      const term = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 14,
        lineHeight: 1.45,
        scrollback: 5000,
        theme: {
          background: "#0d1117",
          foreground: "#d6deeb",
          cursor: "#d6deeb",
          selectionBackground: "#334155",
        },
      });
      let socket = null;
      let reconnectTimer = null;
      let replayOnConnect = true;
      let terminalExited = false;

      term.open(terminalElement);
      term.focus();

      term.onData((data) => {
        sendData(data);
      });

      term.onResize(({cols, rows}) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({type: "resize", cols, rows}));
        }
      });

      terminalElement.addEventListener("pointerdown", () => term.focus());
      window.addEventListener("resize", resizeTerminal);

      function resizeTerminal() {
        const rect = terminalElement.getBoundingClientRect();
        const cols = Math.max(40, Math.floor((rect.width - 20) / 8.5));
        const rows = Math.max(12, Math.floor((rect.height - 20) / 20.3));
        term.resize(cols, rows);
      }

      function sendData(data) {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({type: "data", data}));
        }
      }

      function connectTerminal() {
        const protocol = location.protocol === "https:" ? "wss://" : "ws://";
        const replay = replayOnConnect ? "1" : "0";
        const accessToken = ${JSON.stringify(accessToken)};
        const tokenParam = accessToken ? "&mapache_access=" + encodeURIComponent(accessToken) : "";
        socket = new WebSocket(protocol + location.host + "/terminal?replay=" + replay + tokenParam);
        replayOnConnect = false;

        socket.addEventListener("open", () => {
          resizeTerminal();
        });

        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "data") term.write(message.data);
          if (message.type === "exit") {
            terminalExited = true;
            term.write("\\r\\n[process exited with code " + message.exitCode + "]\\r\\n");
          }
        });

        socket.addEventListener("close", () => {
          if (terminalExited || reconnectTimer) return;
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectTerminal();
          }, 1000);
        });
      }

      resizeTerminal();
      connectTerminal();
    </script>
  </body>
</html>`;
}

module.exports = {
  createTerminalSession,
  renderTerminalPage,
  shouldReplayTerminal,
  terminalArgs,
  terminalCommand,
};
