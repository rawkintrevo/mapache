"use strict";

const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const {WebSocket} = require("ws");

function createTerminalSession({admin, config, activity, onTerminalExit}) {
  const sockets = new Set();
  let term = null;
  let outputBuffer = "";
  let activityTimer = null;
  let pendingActivity = null;
  let piSessionScanTimer = null;
  let piSessionScanAttempts = 0;
  let publishedPiJsonlPath = "";

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

    const command = terminalCommand(config);
    term = spawnTerminal(command, config);

    activity.appendHistory("system", `opened ${command.display}`);
    schedulePiSessionBindingScan(command);

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
      clearPiSessionBindingScan();
      Promise.resolve(onTerminalExit ? onTerminalExit({command, exitCode: code}) : null)
          .catch((error) => {
            const message = error && error.message ? error.message : error;
            console.error("terminal exit hook failed", message);
            activity.appendHistory("system", `exit hook failed: ${message}`);
          });
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

  function schedulePiSessionBindingScan(command) {
    if (!isPiCommand(command.file) || !config.piSessionDir) return;
    piSessionScanAttempts = 0;
    scanPiSessionBinding();
  }

  function clearPiSessionBindingScan() {
    if (piSessionScanTimer) clearTimeout(piSessionScanTimer);
    piSessionScanTimer = null;
  }

  async function scanPiSessionBinding() {
    piSessionScanAttempts += 1;
    try {
      const latest = await findLatestJsonl(config.piSessionDir);
      if (latest && latest.path !== publishedPiJsonlPath) {
        publishedPiJsonlPath = latest.path;
        await activity.updatePiSessionBinding({
          piSessionDir: config.piSessionDir,
          piSessionJsonlPath: latest.path,
          piSessionJsonlRelativePath: path.relative(config.piSessionDir, latest.path).split(path.sep).join("/"),
          piSessionJsonlSize: latest.size,
          piSessionStorageBucket: config.piSessionStorageBucket || config.bucketName || "",
          piSessionStoragePrefix: config.piSessionStoragePrefix || "",
        });
      }
    } catch (error) {
      console.error("pi session binding scan failed", error);
    }

    if (piSessionScanAttempts < 24) {
      piSessionScanTimer = setTimeout(scanPiSessionBinding, 5000);
    }
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

function terminalCommand(config = {}) {
  const command = String(process.env.TERMINAL_COMMAND || "").trim();
  if (command) {
    const args = normalizePiTerminalArgs(command, terminalArgs(), config);
    return {file: command, args, display: [command, ...args].join(" ")};
  }

  const shell = process.env.SHELL || "bash";
  return {file: shell, args: ["-l"], display: `${shell} -l`};
}

function normalizePiTerminalArgs(command, args, config = {}) {
  if (!isPiCommand(command)) return args;

  const explicitSessionPath = String(config.piSessionJsonlPath || process.env.PI_SESSION_JSONL_PATH || "").trim();
  if (explicitSessionPath && pathExistsSync(explicitSessionPath) && !hasPiArg(args, ["--session", "--fork", "--no-session"])) {
    return ["--session", explicitSessionPath, ...stripPiSessionScopeArgs(args)];
  }

  const existingSessionIndex = args.findIndex((arg) => arg === "--session");
  if (existingSessionIndex >= 0) {
    const existingSessionPath = args[existingSessionIndex + 1] || "";
    if (pathExistsSync(existingSessionPath)) return args;
    if (config.piSessionDir) return withPiSessionDir(stripPiSessionScopeArgs(args), config.piSessionDir);
  }

  if (hasPiArg(args, ["--session-dir", "--fork", "--no-session"])) return args;
  if (!config.piSessionDir) return args;
  return withPiSessionDir(args, config.piSessionDir);
}

function withPiSessionDir(args, sessionDir) {
  const scopedArgs = ["--session-dir", sessionDir, ...args];
  return hasPiArg(scopedArgs, ["-c", "--continue", "-r", "--resume"]) ? scopedArgs : [...scopedArgs, "-c"];
}

function stripPiSessionScopeArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--session", "--session-dir"].includes(arg)) {
      index += 1;
      continue;
    }
    if (["-c", "--continue", "-r", "--resume"].includes(arg)) continue;
    result.push(arg);
  }
  return result;
}

function hasPiArg(args, names) {
  return args.some((arg) => names.includes(arg));
}

function isPiCommand(command) {
  return path.basename(String(command || "")) === "pi";
}

function pathExistsSync(value) {
  try {
    return Boolean(value) && fs.existsSync(value);
  } catch {
    return false;
  }
}

async function findLatestJsonl(rootDir) {
  const files = await findJsonlFiles(rootDir);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null;
}

async function findJsonlFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, {withFileTypes: true});
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }

  const results = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findJsonlFiles(entryPath);
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return [];
    const stat = await fs.promises.stat(entryPath);
    return [{path: entryPath, mtimeMs: stat.mtimeMs, size: stat.size}];
  }));
  return results.flat();
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
    <script src="/xterm-fit/lib/addon-fit.js"></script>
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
      const fitAddon = new FitAddon.FitAddon();
      let socket = null;
      let reconnectTimer = null;
      let replayOnConnect = true;
      let terminalExited = false;

      term.loadAddon(fitAddon);
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
        fitAddon.fit();
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
