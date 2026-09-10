"use strict";

const fs = require("fs");
const crypto = require("node:crypto");
const path = require("path");
const {createWorkspaceProcessEnvironment} = require("./runnerEnvironment");
const pty = require("node-pty");
const {WebSocket} = require("ws");
const {prepareSshMaterial, sshCommand} = require("./sshSession");

function createTerminalSession({
  admin,
  config,
  activity,
  onTerminalExit,
  canStartProcess,
  controlManager,
  mutationBarrier,
  executionAuthority,
  processSupervisor,
  webFirstEnabled = false,
  spawnProcess = spawnTerminal,
  timers = globalThis,
}) {
  const sockets = new Set();
  let term = null;
  let outputBuffer = "";
  let activityTimer = null;
  let pendingActivity = null;
  let piSessionScanTimer = null;
  let piSessionScanAttempts = 0;
  let publishedPiJsonlPath = "";
  let releasingForGoal = false;
  let goalHandoffTerm = null;
  let fencedTerm = null;
  let fenced = false;
  const exitReasons = new WeakMap();
  const socketContexts = new Map();

  return {
    isRunning() {
      return Boolean(term);
    },
    controlManager,
    ensureForAgent() {
      return ensureTerm();
    },
    async releaseForGoal() {
      const current = term;
      if (!current) return;
      releasingForGoal = true;
      goalHandoffTerm = current;
      exitReasons.set(current, "mode_switch");
      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            timers.clearTimeout(forceStop);
            timers.clearTimeout(timeout);
            subscription.dispose();
          };
          // Pi's interactive shutdown can stall in extension cleanup. The user
          // has explicitly requested interruption, so bound the graceful wait.
          const forceStop = timers.setTimeout(() => {
            try { current.kill("SIGKILL"); } catch (error) {
              cleanup();
              reject(error);
            }
          }, 5000);
          const timeout = timers.setTimeout(() => {
            cleanup();
            const error = new Error("goal_terminal_stop_timeout");
            error.code = "goal_terminal_stop_timeout";
            reject(error);
          }, 10000);
          const subscription = current.onExit(() => {
            cleanup();
            resolve();
          });
          try { current.kill("SIGTERM"); } catch (error) {
            cleanup();
            reject(error);
          }
        });
      } finally {
        releasingForGoal = false;
      }
    },
    async shutdown(reason = "shutdown") {
      const current = term;
      if (!current) return;
      exitReasons.set(current, String(reason || "shutdown"));
      closeSockets();
      await new Promise((resolve) => {
        let settled = false;
        let forceStop;
        let timeout;
        let subscription;
        const finish = () => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(forceStop);
          timers.clearTimeout(timeout);
          subscription?.dispose?.();
          resolve();
        };
        forceStop = timers.setTimeout(() => {
          try { current.kill("SIGKILL"); } catch { finish(); }
        }, 5000);
        timeout = timers.setTimeout(finish, 10000);
        subscription = current.onExit(finish);
        try { current.kill("SIGTERM"); } catch { finish(); }
      });
    },
    attach(socket, replayOutput) {
      const activeTerm = ensureTerm();
      if (webFirstEnabled && controlManager) {
        socketContexts.set(socket, {
          connectionId: `terminal-${crypto.randomUUID()}`,
          clientId: "",
          resumptionSecret: "",
          bound: false,
        });
      }
      sockets.add(socket);
      updateSocketActivity("lastConnectedAt");
      if (replayOutput && outputBuffer) {
        sendTerminalMessage(socket, {type: "data", data: outputBuffer});
      }
      return activeTerm;
    },
    detach(socket) {
      sockets.delete(socket);
      const context = socketContexts.get(socket);
      if (context) {
        controlManager.disconnect(context.connectionId);
        socketContexts.delete(socket);
      }
      updateSocketActivity("lastDisconnectedAt");
    },
    handleMessage(raw, socket) {
      if (webFirstEnabled && controlManager) {
        handleControlledMessage(socket, raw);
        return;
      }
      handleTerminalMessage(ensureTerm(), raw);
      markTerminalActivity();
    },
    writePrompt(text) {
      if (webFirstEnabled && controlManager) {
        assertMutation("terminal_prompt");
        const error = new Error("web_first_agent_required");
        error.code = "web_first_agent_required";
        throw error;
      }
      const prompt = formatPrompt(text);
      ensureTerm().write(prompt);
      markTerminalActivity();
    },
    fence(reason = "execution_authority_lost") {
      fenced = true;
      const current = term;
      if (!current) return {fenced: true, reason};
      fencedTerm = current;
      exitReasons.set(current, "authority_lost");
      closeSockets();
      try { current.kill("SIGTERM"); } catch (error) {
        activity.appendHistory("system", `terminal fence failed: ${String(error.message || error).slice(0, 256)}`);
      }
      return {fenced: true, reason, pid: current.pid || null};
    },
  };

  function handleControlledMessage(socket, raw) {
    const context = socketContexts.get(socket);
    if (!context) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendTerminalMessage(socket, {type: "control_error", code: "invalid_message"});
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      sendTerminalMessage(socket, {type: "control_error", code: "invalid_message"});
      return;
    }
    try {
      if (message.type === "control_hello") {
        const binding = controlManager.bindConnection({
          clientId: message.clientId,
          resumptionSecret: message.resumptionSecret,
          connectionId: context.connectionId,
          surface: "terminal",
        });
        context.clientId = binding.clientId;
        context.resumptionSecret = binding.resumptionSecret;
        context.bound = true;
        sendTerminalMessage(socket, {type: "control_status", ...binding});
        return;
      }
      if (!context.bound) throw terminalControlError("control_hello_required");
      if (message.type === "control_heartbeat") {
        sendTerminalMessage(socket, {type: "control_status", ...controlManager.heartbeat({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
          expectedControlEpoch: message.controlEpoch,
        })});
        return;
      }
      if (message.type === "control_acquire") {
        sendTerminalMessage(socket, {type: "control_status", ...controlManager.acquire({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
          surface: "terminal",
        })});
        return;
      }
      if (message.type === "control_release") {
        sendTerminalMessage(socket, {type: "control_status", ...controlManager.releaseControl({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
        })});
        return;
      }
      if (message.type === "resize") {
        assertMutation("terminal_resize");
        controlManager.assertCanWrite({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
          expectedControlEpoch: message.controlEpoch,
        });
        handleTerminalMessage(ensureTerm(), raw);
        return;
      }
      if (message.type === "data") {
        assertMutation("terminal_input");
        controlManager.acquire({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
          surface: "terminal",
        });
        controlManager.assertCanWrite({
          clientId: context.clientId,
          resumptionSecret: context.resumptionSecret,
          connectionId: context.connectionId,
        });
        handleTerminalMessage(ensureTerm(), raw);
        markTerminalActivity();
        return;
      }
      throw terminalControlError("invalid_terminal_message");
    } catch (error) {
      sendTerminalMessage(socket, {type: "control_error", code: String(error.code || "control_required")});
    }
  }

  function ensureTerm() {
    if (webFirstEnabled && executionAuthority) executionAuthority.assertAuthority();
    if (webFirstEnabled && fenced) {
      const error = new Error("execution_authority_lost");
      error.code = "execution_authority_lost";
      throw error;
    }
    if (releasingForGoal) {
      const error = new Error("goal_rpc_process_active");
      error.code = "goal_rpc_process_active";
      throw error;
    }
    if (term) return term;
    if (typeof canStartProcess === "function" && !canStartProcess()) {
      const error = new Error("goal_rpc_process_active");
      error.code = "goal_rpc_process_active";
      throw error;
    }

    outputBuffer = "";

    const command = terminalCommand(config);
    term = spawnProcess(command, config);
    const spawnedTerm = term;
    const unregisterProcess = processSupervisor?.register?.(term, {id: "pi-terminal", label: "pi-terminal"});

    activity.appendHistory("system", `opened ${command.display}`);
    schedulePiSessionBindingScan(command);

    term.onData((data) => {
      appendToBuffer(data);
      broadcast({type: "data", data});
      activity.appendHistory("stdout", data);
      markTerminalActivity();
    });

    term.onExit(({exitCode: code}) => {
      const exitReason = exitReasons.get(spawnedTerm) || "completed";
      activity.appendHistory("system", `closed with exit code ${code}`);
      broadcast({type: "exit", exitCode: code});
      closeSockets();
      term = null;
      clearPiSessionBindingScan();
      unregisterProcess?.();
      if (fencedTerm === spawnedTerm) {
        fencedTerm = null;
        return;
      }
      // A mode switch is not session completion: do not commit/push the
      // workspace or finalize its automation branch during the handoff.
      if (goalHandoffTerm === spawnedTerm) {
        goalHandoffTerm = null;
        return;
      }
      Promise.resolve(onTerminalExit ? onTerminalExit({command, exitCode: code, reason: exitReason}) : null)
          .catch((error) => {
            const message = error && error.message ? error.message : error;
            console.error("terminal exit hook failed", message);
            activity.appendHistory("system", `exit hook failed: ${message}`);
          });
    });

    return term;
  }

  function assertMutation(label) {
    if (!webFirstEnabled) return true;
    executionAuthority?.assertAuthority?.();
    mutationBarrier?.assertOpen?.(label);
    return true;
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
    activity.updateSessionActivity(socketActivityUpdate(
        sockets.size,
        timestampField,
        admin.firestore.FieldValue.serverTimestamp(),
    ));
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

function socketActivityUpdate(activeSocketCount, timestampField, timestamp) {
  return {
    activeSocketCount,
    [timestampField]: timestamp,
  };
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
      ...createWorkspaceProcessEnvironment(config),
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

function formatPrompt(text) {
  return `\x1b[200~${String(text)}\x1b[201~\r`;
}

function sendTerminalMessage(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function terminalControlError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function terminalCommand(config = {}) {
  if (String(config.harnessId || config.terminalKind || "").trim().toLowerCase() === "ssh") {
    prepareSshMaterial(config);
    return sshCommand(config, {tty: true, loginShell: true});
  }

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
  let normalized = args;
  if (explicitSessionPath && pathExistsSync(explicitSessionPath) && !hasPiArg(args, ["--session", "--fork", "--no-session"])) {
    normalized = ["--session", explicitSessionPath, ...stripPiSessionScopeArgs(args)];
  } else {
    const existingSessionIndex = args.findIndex((arg) => arg === "--session");
    if (existingSessionIndex >= 0) {
      const existingSessionPath = args[existingSessionIndex + 1] || "";
      if (pathExistsSync(existingSessionPath)) normalized = args;
      else if (config.piSessionDir) normalized = withPiSessionDir(stripPiSessionScopeArgs(args), config.piSessionDir);
    }
  }
  if (!hasPiArg(normalized, ["--session", "--session-dir", "--fork", "--no-session"]) && config.piSessionDir) {
    normalized = withPiSessionDir(normalized, config.piSessionDir);
  }
  if (config.webFirstEnabled) {
    const extensionPath = String(process.env.MAPACHE_PI_WEB_FIRST_EXTENSION || "/app/lib/piWebFirstAdapter.extension.mjs").trim();
    if (extensionPath && !normalized.includes(extensionPath)) normalized = [...normalized, "-e", extensionPath];
  }
  return normalized;
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
  const socketPath = String(options.socketPath || "/terminal");
  const webFirstEnabled = Boolean(options.webFirstEnabled);
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
        overflow: hidden;
      }
      #terminal {
        height: 100%;
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
      }
      #terminal .xterm {
        height: 100%;
        position: relative;
      }
      #terminal .xterm-helpers {
        position: absolute;
        top: 0;
        z-index: 5;
      }
      #terminal .xterm-helper-textarea {
        position: absolute;
        opacity: 0;
        color: transparent;
        background: transparent;
        caret-color: transparent;
        text-shadow: none;
        white-space: nowrap;
        overflow: hidden;
        resize: none;
      }
      #terminal .composition-view {
        display: none;
        position: absolute;
        white-space: nowrap;
        z-index: 1;
      }
      #terminal .composition-view.active {
        display: block;
      }
      #terminal .xterm-viewport {
        position: absolute;
        inset: 0;
        overflow-y: scroll;
      }
      #terminal .xterm-screen,
      #terminal .xterm-screen canvas {
        position: absolute;
        inset: 0;
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
      const helperTextareaStyles = {
        opacity: "0",
        color: "transparent",
        background: "transparent",
        caretColor: "transparent",
        textShadow: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        resize: "none",
      };
      let socket = null;
      let reconnectTimer = null;
      let replayOnConnect = true;
      let terminalExited = false;
      const webFirstEnabled = ${JSON.stringify(webFirstEnabled)};
      const controlStorageKey = "mapache-control:" + location.pathname;
      const controlClientId = getStoredControlValue("clientId") || createControlId();
      let controlResumptionSecret = getStoredControlValue("resumptionSecret");
      let controlReady = false;
      let controlHeartbeatTimer = null;

      term.loadAddon(fitAddon);
      term.open(terminalElement);
      term.focus();
      const helperTextarea = term.textarea;

      function applyHelperTextareaStyles() {
        if (!helperTextarea) return;
        Object.assign(helperTextarea.style, helperTextareaStyles);
      }

      applyHelperTextareaStyles();
      if (helperTextarea) {
        helperTextarea.addEventListener("focus", applyHelperTextareaStyles, true);
      }

      term.onData((data) => {
        sendData(data);
      });

      term.onRender(() => {
        applyHelperTextareaStyles();
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

      function createControlId() {
        const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function" ?
          globalThis.crypto.randomUUID() : "client-" + Math.random().toString(36).slice(2);
        storeControlValue("clientId", id);
        return id;
      }

      function getStoredControlValue(name) {
        if (!webFirstEnabled) return "";
        try { return sessionStorage.getItem(controlStorageKey + ":" + name) || ""; } catch { return ""; }
      }

      function storeControlValue(name, value) {
        if (!webFirstEnabled) return;
        try { sessionStorage.setItem(controlStorageKey + ":" + name, value); } catch {}
      }

      function sendControlHello() {
        if (!webFirstEnabled || !socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({type: "control_hello", clientId: controlClientId, resumptionSecret: controlResumptionSecret}));
      }

      function startControlHeartbeat() {
        if (!webFirstEnabled || controlHeartbeatTimer) return;
        controlHeartbeatTimer = window.setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN && controlReady) {
            socket.send(JSON.stringify({type: "control_heartbeat"}));
          }
        }, 10000);
      }

      function connectTerminal() {
        const protocol = location.protocol === "https:" ? "wss://" : "ws://";
        const replay = replayOnConnect ? "1" : "0";
        const accessToken = ${JSON.stringify(accessToken)};
        const tokenParam = accessToken ? "&mapache_access=" + encodeURIComponent(accessToken) : "";
        controlReady = false;
        socket = new WebSocket(protocol + location.host + ${JSON.stringify(socketPath)} + "?replay=" + replay + tokenParam);
        replayOnConnect = false;

        socket.addEventListener("open", () => {
          sendControlHello();
          startControlHeartbeat();
          resizeTerminal();
        });

        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "data") term.write(message.data);
          if (message.type === "control_status") {
            controlReady = true;
            if (message.resumptionSecret) {
              controlResumptionSecret = message.resumptionSecret;
              storeControlValue("resumptionSecret", controlResumptionSecret);
            }
            resizeTerminal();
          }
          if (message.type === "control_error" && message.code === "control_binding_invalid") {
            controlResumptionSecret = "";
            try { sessionStorage.removeItem(controlStorageKey + ":resumptionSecret"); } catch {}
          }
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
  socketActivityUpdate,
  renderTerminalPage,
  shouldReplayTerminal,
  terminalArgs,
  terminalCommand,
  formatPrompt,
};
