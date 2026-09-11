"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");

const adapterPath = String(process.env.PI_WEB_MCP_ADAPTER_PATH || "").trim();
const runtimeRoot = String(process.env.PI_WEB_SDK_ROOT || process.env.MAPACHE_PI_WEB_UI_ROOT || "").trim();
const available = Boolean(adapterPath && runtimeRoot);

test("discovers the pinned MCP adapter once and calls one deterministic fixture tool", {skip: !available && "requires a built pi-web runtime and PI_WEB_MCP_ADAPTER_PATH"}, async () => {
  const sdkEntry = path.join(runtimeRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  const {createAgentSessionFromServices, createAgentSessionServices, SessionManager} = await import(pathToFileURL(sdkEntry).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-managed-mcp-integration-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const instanceFile = path.join(root, "fixture-instances.log");
  const fixturePath = path.resolve(__dirname, "../test/fixtures/managed-mcp-single-server.mjs");
  const previousManaged = process.env.PI_WEB_MANAGED;
  const previousInstanceFile = process.env.MCP_FIXTURE_INSTANCE_FILE;
  await fs.mkdir(cwd, {recursive: true});
  await fs.mkdir(agentDir, {recursive: true});
  await fs.writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: {fixture: {command: process.execPath, args: [fixturePath]}},
  }));
  process.env.PI_WEB_MANAGED = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.MCP_FIXTURE_INSTANCE_FILE = instanceFile;
  let runner;
  try {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {additionalExtensionPaths: [adapterPath]},
    });
    assert.deepEqual(services.diagnostics, []);
    const extensionResult = services.resourceLoader.getExtensions();
    assert.equal(extensionResult.errors.length, 0);
    assert.deepEqual(extensionResult.extensions.map((extension) => extension.path), [adapterPath]);
    assert.deepEqual([...extensionResult.extensions[0].tools.keys()], ["mcpScript", "mcp"]);

    const session = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(cwd, sessionsDir),
    });
    runner = session.session._extensionRunner;
    assert.deepEqual(runner.extensions.filter((extension) => extension.path === adapterPath).map((extension) => extension.path), [adapterPath]);
    await runner.emit({type: "session_start", reason: "startup"});
    const mcpTool = runner.extensions.find((extension) => extension.path === adapterPath).tools.get("mcp").definition;
    const search = await mcpTool.execute("search", {search: "echo"}, undefined, undefined, {});
    assert.equal(search.details.count, 1);
    assert.match(search.content[0].text, /fixture_echo/);
    const call = await mcpTool.execute("call", {tool: "echo", server: "fixture", args: {message: "fixture-ok"}}, undefined, undefined, {});
    assert.equal(call.content[0].text, "fixture-ok");
    assert.deepEqual((await fs.readFile(instanceFile, "utf8")).trim().split(/\n/).length, 1);
    await runner.emit({type: "session_shutdown", reason: "test"});
  } finally {
    if (runner) await runner.emit({type: "session_shutdown", reason: "cleanup"}).catch(() => {});
    if (previousManaged === undefined) delete process.env.PI_WEB_MANAGED;
    else process.env.PI_WEB_MANAGED = previousManaged;
    if (previousInstanceFile === undefined) delete process.env.MCP_FIXTURE_INSTANCE_FILE;
    else process.env.MCP_FIXTURE_INSTANCE_FILE = previousInstanceFile;
    await fs.rm(root, {recursive: true, force: true});
  }
});
