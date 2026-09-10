"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");
const {createPiWebFirstAdapter} = require("../../lib/piWebFirstAdapter");

const ADAPTER_EXTENSION = path.resolve(__dirname, "../../lib/piWebFirstAdapter.extension.mjs");

/**
 * Disposable, isolated Gate A fixture. It owns the temporary Pi home,
 * workspace, socket, PTY, and adapter connection and cleans all of them up.
 */
async function createGateAFixture({
  piCommand = process.env.PI_COMMAND || "pi",
  spawn = pty.spawn,
  adapterRevision,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-web-first-gate-a-"));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const workspaceDir = path.join(root, "workspace");
  const sessionDir = path.join(agentDir, "mapache-sessions", "fixture");
  const socketPath = path.join(root, "adapter.sock");
  await fs.mkdir(sessionDir, {recursive: true, mode: 0o700});
  await fs.mkdir(workspaceDir, {recursive: true, mode: 0o700});
  await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n", {mode: 0o600});
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", {mode: 0o600});

  let process;
  let adapter;
  let exited = false;
  try {
    const args = [
      "--session-dir", sessionDir,
      "-e", ADAPTER_EXTENSION,
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
    ];
    process = spawn(piCommand, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 32,
      cwd: workspaceDir,
      env: {
        ...processEnv(),
        HOME: homeDir,
        PI_CODING_AGENT_DIR: agentDir,
        MAPACHE_PI_WEB_FIRST_SOCKET: socketPath,
        MAPACHE_PI_WEB_FIRST_ADAPTER_REVISION: adapterRevision || "gate-a-0.1.0",
        PI_GOAL_X_VERSION: "0.31.2",
        TERM: "xterm-256color",
      },
    });
    process.onExit?.(() => { exited = true; });
    adapter = createPiWebFirstAdapter({socketPath, adapterRevision: adapterRevision || "gate-a-0.1.0"});
    return {
      root,
      homeDir,
      agentDir,
      workspaceDir,
      sessionDir,
      socketPath,
      process,
      adapter,
      get exited() { return exited; },
      attachTerminalClient() {
        const client = {data: "", attached: true};
        const subscription = process.onData?.((data) => {
          if (client.attached) client.data += data;
        });
        return {
          client,
          detach() {
            client.attached = false;
            subscription?.dispose?.();
          },
        };
      },
      async cleanup() {
        adapter?.disconnect();
        if (process && !exited) {
          try { process.kill("SIGTERM"); } catch {}
          await waitForExit(process, 5000).catch(() => {
            try { process.kill("SIGKILL"); } catch {}
          });
        }
        await fs.rm(root, {recursive: true, force: true});
      },
    };
  } catch (error) {
    adapter?.disconnect();
    if (process) {
      try { process.kill("SIGKILL"); } catch {}
    }
    await fs.rm(root, {recursive: true, force: true});
    throw error;
  }
}

function processEnv() {
  const env = {...process.env};
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== undefined && child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gate_a_fixture_exit_timeout")), timeoutMs);
    child.onExit?.(() => { clearTimeout(timer); resolve(); });
  });
}

module.exports = {ADAPTER_EXTENSION, createGateAFixture};
