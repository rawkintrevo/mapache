"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const {spawn, execFile} = require("child_process");

function createSshSessionService({config}) {
  const forwards = new Map();

  return {
    enabled: () => config.terminalKind === "ssh",
    prepare: () => prepareSshMaterial(config),
    terminalCommand: () => sshCommand(config, {tty: true, loginShell: true}),
    listFiles: () => withPreparedSsh(config, () => listFiles(config)),
    readFile: (relativePath) => withPreparedSsh(config, () => readFile(config, relativePath)),
    saveFile: (relativePath, content) => withPreparedSsh(config, () => saveFile(config, relativePath, content)),
    createForward: (port) => withPreparedSsh(config, () => createForward(config, forwards, port)),
    closeForward: (port) => closeForward(forwards, port),
    listForwards: () => Array.from(forwards.values()).map(publicForward),
    proxyForward: (req, res, port) => proxyForward(forwards, req, res, port),
    closeAll: () => closeAllForwards(forwards),
  };
}

function withPreparedSsh(config, action) {
  prepareSshMaterial(config);
  return action();
}

function prepareSshMaterial(config) {
  if (config.terminalKind !== "ssh") return;
  if (!config.sshHost || !config.sshUsername || !config.sshPrivateKey) {
    throw new Error("SSH sessions require SSH_TARGET_HOST, SSH_TARGET_USERNAME, and SSH_PRIVATE_KEY.");
  }
  if (config.sshAuthMode === "certificate" && !config.sshCertificate) {
    throw new Error("Certificate SSH sessions require SSH_CERTIFICATE.");
  }
  fs.mkdirSync(config.sshConfigDir, {recursive: true, mode: 0o700});
  writeSecretFile(config.sshPrivateKeyPath, config.sshPrivateKey, 0o600);
  if (config.sshAuthMode === "certificate") {
    writeSecretFile(config.sshCertificatePath, config.sshCertificate, 0o644);
  }
  if (config.sshKnownHosts) writeSecretFile(config.sshKnownHostsPath, config.sshKnownHosts, 0o644);
}

function writeSecretFile(filePath, value, mode) {
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`, {mode});
}

function sshCommand(config, options = {}) {
  const args = baseSshArgs(config);
  if (options.tty) args.push("-tt");
  if (options.loginShell) {
    args.push(remoteTarget(config), `cd ${shellRemotePath(config.sshInitialDirectory)} && exec ${shellQuote(config.sshShell)} -l`);
  } else {
    args.push(remoteTarget(config));
  }
  return {file: "ssh", args, display: `ssh ${config.sshUsername}@${config.sshHost}`};
}

function baseSshArgs(config) {
  const args = [
    "-p", String(config.sshPort),
    "-i", config.sshPrivateKeyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
  ];
  if (config.sshAuthMode === "certificate") {
    args.push("-o", `CertificateFile=${config.sshCertificatePath}`);
  }
  if (config.sshKnownHosts) {
    args.push("-o", `UserKnownHostsFile=${config.sshKnownHostsPath}`, "-o", "StrictHostKeyChecking=yes");
  } else if (config.sshStrictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=accept-new");
  } else {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }
  return args;
}

function remoteTarget(config) {
  return `${config.sshUsername}@${config.sshHost}`;
}

async function listFiles(config) {
  const command = [
    "cd", shellRemotePath(config.sshInitialDirectory), "&&",
    "find . -maxdepth 8 -type f -size -1048576c | sed 's#^./##' | sort | head -500",
  ].join(" ");
  const stdout = await sshExec(config, command);
  const files = stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((relativePath) => ({
    name: path.posix.basename(relativePath),
    path: relativePath,
    size: null,
    updatedAt: "",
  }));
  return {ok: true, files, truncated: files.length >= 500, root: config.sshInitialDirectory, scope: "initial-directory"};
}

async function readFile(config, relativePath) {
  const clean = normalizeScopedPath(relativePath);
  const command = `cd ${shellRemotePath(config.sshInitialDirectory)} && test -f ${shellQuote(clean)} && wc -c < ${shellQuote(clean)} && cat ${shellQuote(clean)}`;
  const stdout = await sshExec(config, command, {maxBuffer: config.sshMaxFileBytes + 1024});
  const newline = stdout.indexOf("\n");
  const size = Number(stdout.slice(0, newline).trim());
  if (!Number.isFinite(size) || size > config.sshMaxFileBytes) {
    const error = new Error("ssh_file_too_large");
    error.status = 413;
    throw error;
  }
  return {ok: true, path: clean, name: path.posix.basename(clean), content: stdout.slice(newline + 1), updatedAt: ""};
}

async function saveFile(config, relativePath, content) {
  const clean = normalizeScopedPath(relativePath);
  const text = String(content || "");
  if (Buffer.byteLength(text, "utf8") > config.sshMaxFileBytes) {
    const error = new Error("ssh_file_too_large");
    error.status = 413;
    throw error;
  }
  await sshExec(config, `cd ${shellRemotePath(config.sshInitialDirectory)} && mkdir -p ${shellQuote(path.posix.dirname(clean))} && cat > ${shellQuote(clean)}`, {
    input: text,
    maxBuffer: 1024 * 1024,
  });
  return {ok: true, path: clean, name: path.posix.basename(clean), updatedAt: new Date().toISOString()};
}

function normalizeScopedPath(value) {
  const clean = path.posix.normalize(String(value || "").replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!clean || clean === "." || clean === ".." || clean.startsWith("../")) {
    const error = new Error("invalid_ssh_file_path");
    error.status = 400;
    throw error;
  }
  return clean;
}

function sshExec(config, remoteCommand, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", [...baseSshArgs(config), remoteTarget(config), remoteCommand], {
      maxBuffer: options.maxBuffer || 1024 * 1024,
      timeout: options.timeout || 30000,
    }, (error, stdout, stderr) => {
      if (error) {
        error.publicMessage = stderr ? stderr.trim().slice(0, 300) : "ssh_command_failed";
        reject(error);
        return;
      }
      resolve(stdout);
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

async function createForward(config, forwards, portValue) {
  const remotePort = normalizePort(portValue);
  if (forwards.has(remotePort)) return {ok: true, forward: publicForward(forwards.get(remotePort))};
  const localPort = await reserveLocalPort();
  const args = [
    ...baseSshArgs(config),
    "-N",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    remoteTarget(config),
  ];
  const child = spawn("ssh", args, {stdio: ["ignore", "ignore", "pipe"]});
  const forward = {remotePort, localPort, child, createdAt: new Date().toISOString()};
  forwards.set(remotePort, forward);
  child.on("exit", () => {
    if (forwards.get(remotePort) === forward) forwards.delete(remotePort);
  });
  child.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) console.error(`ssh forward ${remotePort}: ${message}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {ok: true, forward: publicForward(forward)};
}

function closeForward(forwards, portValue) {
  const remotePort = normalizePort(portValue);
  const forward = forwards.get(remotePort);
  if (forward) {
    forward.child.kill("SIGTERM");
    forwards.delete(remotePort);
  }
  return {ok: true};
}

function closeAllForwards(forwards) {
  for (const forward of forwards.values()) forward.child.kill("SIGTERM");
  forwards.clear();
}

function publicForward(forward) {
  return {
    port: forward.remotePort,
    createdAt: forward.createdAt,
    path: `/ssh/forward/${forward.remotePort}/`,
  };
}

function proxyForward(forwards, req, res, portValue) {
  const remotePort = normalizePort(portValue);
  const forward = forwards.get(remotePort);
  if (!forward) {
    res.status(404).send("forward not found");
    return;
  }
  const suffix = req.params && req.params[0] ? `/${req.params[0]}` : "/";
  const request = http.request({
    hostname: "127.0.0.1",
    port: forward.localPort,
    method: req.method,
    path: `${suffix}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`,
    headers: {...req.headers, host: `127.0.0.1:${forward.localPort}`},
  }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  request.on("error", () => {
    if (!res.headersSent) res.status(502).send("forward unavailable");
  });
  req.pipe(request);
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error("invalid_forward_port");
    error.status = 400;
    throw error;
  }
  return port;
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function shellRemotePath(value) {
  const text = String(value || "~");
  if (text === "~") return "~";
  if (text.startsWith("~/")) return `~/${shellQuote(text.slice(2))}`;
  return shellQuote(text);
}

module.exports = {
  createSshSessionService,
  prepareSshMaterial,
  sshCommand,
};
