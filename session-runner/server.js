"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const pty = require("node-pty");
const {WebSocketServer} = require("ws");
const {Storage} = require("@google-cloud/storage");
const admin = require("firebase-admin");

const port = Number(process.env.PORT || 8080);
const workspaceDir = process.env.WORKSPACE_DIR || "/workspace";
const bucketName = process.env.STORAGE_BUCKET || "";
const prefix = normalizePrefix(process.env.STORAGE_PREFIX || "");
const workspaceId = process.env.WORKSPACE_ID || "";
const sessionId = process.env.SESSION_ID || "";
const syncIntervalMs = Number(process.env.SYNC_INTERVAL_MS || 30000);
const directoryMarkerFile = ".mapahce-directory";

admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server, path: "/terminal"});

app.use(
    "/xterm",
    express.static(path.join(__dirname, "node_modules", "@xterm", "xterm")),
);

app.get("/", (req, res) => {
  res.type("html").send(renderTerminalPage());
});

app.get("/healthz", (req, res) => {
  res.json({ok: true, workspaceId, sessionId, bucketName, prefix});
});

wss.on("connection", (socket) => {
  const command = terminalCommand();
  const term = pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: 100,
    rows: 32,
    cwd: workspaceDir,
    env: {...process.env, TERM: "xterm-256color"},
  });

  appendHistory("system", `opened ${command.display}`);

  term.onData((data) => {
    socket.send(JSON.stringify({type: "data", data}));
    appendHistory("stdout", data);
  });

  term.onExit(({exitCode}) => {
    appendHistory("system", `closed with exit code ${exitCode}`);
    socket.close();
  });

  socket.on("message", (raw) => {
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
  });

  socket.on("close", () => {
    term.kill();
  });
});

ensureWorkspace()
    .then(syncDown)
    .then(() => {
      setInterval(() => {
        syncUp().catch((error) => console.error("sync up failed", error));
      }, syncIntervalMs);
      server.listen(port, () => {
        console.log(`session runner listening on ${port}`);
      });
    })
    .catch((error) => {
      console.error("session runner failed to start", error);
      process.exit(1);
    });

async function ensureWorkspace() {
  await fs.promises.mkdir(workspaceDir, {recursive: true});
}

async function syncDown() {
  if (!bucketName || !prefix) return;
  const [files] = await storage.bucket(bucketName).getFiles({prefix});
  await Promise.all(files.map(async (file) => {
    if (file.name.endsWith("/")) return;
    const relative = file.name.slice(prefix.length).replace(/^\//, "");
    if (!relative) return;
    if (relative.endsWith(`/${directoryMarkerFile}`)) {
      await fs.promises.mkdir(path.join(workspaceDir, path.dirname(relative)), {recursive: true});
      return;
    }
    const localPath = path.join(workspaceDir, relative);
    await fs.promises.mkdir(path.dirname(localPath), {recursive: true});
    await file.download({destination: localPath});
  }));
}

async function syncUp() {
  if (!bucketName || !prefix) return;
  const {directories, files} = await walkWorkspace(workspaceDir);
  await Promise.all(directories.map(async (localPath) => {
    const relative = path.relative(workspaceDir, localPath);
    if (!relative) return;
    const remotePath = `${prefix}/${relative}/${directoryMarkerFile}`.replace(/\/+/g, "/");
    await storage.bucket(bucketName).file(remotePath).save("", {
      contentType: "text/plain",
      resumable: false,
    });
  }));
  await Promise.all(files.map(async (localPath) => {
    const relative = path.relative(workspaceDir, localPath);
    const remotePath = `${prefix}/${relative}`.replace(/\/+/g, "/");
    await storage.bucket(bucketName).upload(localPath, {destination: remotePath});
  }));
}

async function walkWorkspace(dir) {
  const entries = await fs.promises.readdir(dir, {withFileTypes: true});
  const results = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkWorkspace(entryPath);
    if (entry.isFile()) return {directories: [], files: [entryPath]};
    return {directories: [], files: []};
  }));
  return results.reduce((acc, result) => {
    acc.directories.push(...result.directories);
    acc.files.push(...result.files);
    return acc;
  }, {
    directories: dir === workspaceDir ? [] : [dir],
    files: [],
  });
}

async function appendHistory(stream, data) {
  if (!workspaceId || !sessionId) return;
  const body = String(data || "");
  if (!body) return;
  await db.collection("workspaces")
      .doc(workspaceId)
      .collection("sessions")
      .doc(sessionId)
      .collection("terminalHistory")
      .add({
        stream,
        data: body.slice(0, 4096),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((error) => console.error("terminal history write failed", error));
}

function normalizePrefix(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
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
    const value = JSON.parse(process.env.TERMINAL_ARGS || "[]");
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch (error) {
    console.error("invalid TERMINAL_ARGS, using no arguments", error);
    return [];
  }
}

function renderTerminalPage() {
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
      const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/terminal");

      term.open(terminalElement);
      term.focus();

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "data") term.write(message.data);
      });

      term.onData((data) => {
        sendData(data);
      });

      term.onResize(({cols, rows}) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({type: "resize", cols, rows}));
        }
      });

      terminalElement.addEventListener("pointerdown", () => term.focus());
      window.addEventListener("resize", resizeTerminal);
      socket.addEventListener("open", resizeTerminal);

      function resizeTerminal() {
        const rect = terminalElement.getBoundingClientRect();
        const cols = Math.max(40, Math.floor((rect.width - 20) / 8.5));
        const rows = Math.max(12, Math.floor((rect.height - 20) / 20.3));
        term.resize(cols, rows);
      }

      function sendData(data) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({type: "data", data}));
        }
      }

      resizeTerminal();
    </script>
  </body>
</html>`;
}
