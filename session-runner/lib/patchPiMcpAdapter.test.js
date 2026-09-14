"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {patchPiMcpAdapter} = require("./patchPiMcpAdapter");

const INDEX = `
const parseArgs = (value: unknown) => value;
const registerMcpCommand = (commandName: string) => pi.registerCommand(commandName, {
    handler: async (args, ctx) => {
      const commandCtx = { hasUI: ctx.hasUI };
      const parts = args?.trim()?.split(/\\s+/) ?? [];
      const subcommand = parts[0] ?? "";
        const parsedArgs = parseArgs(params.args);
      switch (subcommand) {
        case "status":
        case "":
        default:
          if (commandCtx.hasUI) {
            await openMcpPanel(state, pi, commandCtx, earlyConfigPath, () => {});
          }
          break;
      }
    },
});
  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const commandOwner = currentOwner;
      return commandOwner;
    },
  });
`;
const CONFIG = `
function writeRawConfigObject(filePath: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(raw), "utf-8");
}
`;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-pi-mcp-patch-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({name: "pi-mcp-adapter", version: "2.32.1", pi: {extensions: ["./index.ts"]}}));
  await fs.writeFile(path.join(root, "index.ts"), INDEX);
  await fs.writeFile(path.join(root, "config.ts"), CONFIG);
  await fs.writeFile(path.join(root, "mcp-bearer-store.ts"), "export function saveBearerTokenForUrl(serverName: string, token: string, serverUrl: string): void {}\nexport function removeBearerToken(serverName: string): void {}\n");
  return root;
}

test("patches MCP commands and the central config writer", async () => {
  const root = await fixture();
  try {
    const result = patchPiMcpAdapter({packageRoot: root});
    assert.equal(result.patched, true);
    const index = await fs.readFile(path.join(root, "index.ts"), "utf8");
    const config = await fs.readFile(path.join(root, "config.ts"), "utf8");
    const bearerStore = await fs.readFile(path.join(root, "mcp-bearer-store.ts"), "utf8");
    assert.match(index, /MAPACHE_MANAGED_MCP_MUTATION_GUARD/);
    assert.match(index, /\["setup", "logout", "token", "disable", "enable"\]/);
    assert.match(index, /params\.action === "auth-start"/);
    assert.match(index, /await showStatus\(state, commandCtx\)/);
    assert.match(index, /ctx\.ui\?\.notify/);
    assert.match(config, /if \(MAPACHE_MANAGED_MCP_MUTATION_GUARD\) throw new Error/);
    assert.match(bearerStore, /assertManagedMcpCredentialMutationAllowed/);
    assert.equal(patchPiMcpAdapter({packageRoot: root}).reason, "already_patched");
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("fails closed for an unsupported adapter version", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({name: "pi-mcp-adapter", version: "9.9.9", pi: {extensions: ["./index.ts"]}}));
    assert.throws(() => patchPiMcpAdapter({packageRoot: root}), /pi_mcp_adapter_version_mismatch/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
