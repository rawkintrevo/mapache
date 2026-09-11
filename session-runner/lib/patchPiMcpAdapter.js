"use strict";

const fs = require("fs");
const path = require("path");

const EXPECTED_PACKAGE = "pi-mcp-adapter";
const EXPECTED_VERSION = "2.32.1";
const MANAGED_MARKER = "MAPACHE_MANAGED_MCP_MUTATION_GUARD";
const MANAGED_REFUSAL = "MCP configuration and credentials are managed by Mapache.";

/**
 * Add the small managed-mode policy layer to the pinned adapter package.
 *
 * The adapter remains the only MCP transport implementation. This build-time
 * patch only makes its optional TUI/config writers read-only when the package
 * is loaded by the embedded managed agent. Anchor and package checks are
 * intentionally strict: a future incompatible adapter must fail the image
 * build instead of silently losing the ownership boundary.
 */
function patchPiMcpAdapter({
  packageRoot = process.env.PI_MCP_ADAPTER_DIR || path.join(process.env.HOME || "/root", ".pi", "agent", "npm", "node_modules", EXPECTED_PACKAGE),
  fsModule = fs,
} = {}) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const indexPath = path.join(packageRoot, "index.ts");
  const configPath = path.join(packageRoot, "config.ts");
  const bearerStorePath = path.join(packageRoot, "mcp-bearer-store.ts");
  let packageJson;
  try {
    packageJson = JSON.parse(fsModule.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {patched: false, reason: "managed_package_missing", packageRoot};
    throw error;
  }
  if (packageJson.name !== EXPECTED_PACKAGE || packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`pi_mcp_adapter_version_mismatch: expected ${EXPECTED_PACKAGE}@${EXPECTED_VERSION}`);
  }
  if (!packageJson.pi?.extensions?.includes("./index.ts")) {
    throw new Error("pi_mcp_adapter_manifest_anchor_missing");
  }

  const indexSource = fsModule.readFileSync(indexPath, "utf8");
  const configSource = fsModule.readFileSync(configPath, "utf8");
  const bearerStoreSource = fsModule.readFileSync(bearerStorePath, "utf8");
  if (indexSource.includes(MANAGED_MARKER) && configSource.includes(MANAGED_MARKER) && bearerStoreSource.includes(MANAGED_MARKER)) {
    return {patched: false, reason: "already_patched", packageRoot};
  }
  if (indexSource.includes(MANAGED_MARKER) || configSource.includes(MANAGED_MARKER) || bearerStoreSource.includes(MANAGED_MARKER)) {
    throw new Error("pi_mcp_adapter_partial_patch");
  }

  const indexAnchor = 'const registerMcpCommand = (commandName: string) => pi.registerCommand(commandName, {';
  if (!indexSource.includes(indexAnchor)) throw new Error("pi_mcp_adapter_index_anchor_missing");
  const authAnchor = '  pi.registerCommand("mcp-auth", {';
  if (!indexSource.includes(authAnchor)) throw new Error("pi_mcp_adapter_auth_anchor_missing");
  const configAnchor = "function writeRawConfigObject(filePath: string, raw: Record<string, unknown>): void {";
  if (!configSource.includes(configAnchor)) throw new Error("pi_mcp_adapter_config_anchor_missing");
  const bearerWriteAnchor = "export function saveBearerTokenForUrl(serverName: string, token: string, serverUrl: string): void {";
  const bearerRemoveAnchor = "export function removeBearerToken(serverName: string): void {";
  if (!bearerStoreSource.includes(bearerWriteAnchor) || !bearerStoreSource.includes(bearerRemoveAnchor)) {
    throw new Error("pi_mcp_adapter_bearer_store_anchor_missing");
  }

  const managedIndexPrelude = `
const ${MANAGED_MARKER} = (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "1" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "true" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "yes" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "on";
const MAPACHE_MANAGED_MCP_REFUSAL = ${JSON.stringify(MANAGED_REFUSAL)};
`;
  let nextIndex = indexSource.replace(indexAnchor, `${managedIndexPrelude}\n${indexAnchor}`);
  const commandGuard = `      if (${MANAGED_MARKER} && ["setup", "logout", "token", "disable", "enable"].includes(subcommand)) {
        if (commandCtx.hasUI) commandCtx.ui?.notify(MAPACHE_MANAGED_MCP_REFUSAL, "info");
        return;
      }
`;
  const subcommandAnchor = "      const subcommand = parts[0] ?? \"\";\n";
  if (!nextIndex.includes(subcommandAnchor)) throw new Error("pi_mcp_adapter_command_anchor_missing");
  nextIndex = nextIndex.replace(subcommandAnchor, `${subcommandAnchor}${commandGuard}`);
  const actionAnchor = "        const parsedArgs = parseArgs(params.args);\n";
  if (!nextIndex.includes(actionAnchor)) throw new Error("pi_mcp_adapter_action_anchor_missing");
  const actionGuard = `        if (${MANAGED_MARKER} && (params.action === "auth-start" || params.action === "auth-complete")) {
          return {
            content: [{ type: "text" as const, text: MAPACHE_MANAGED_MCP_REFUSAL }],
            details: { error: "managed_credentials" },
          };
        }
`;
  nextIndex = nextIndex.replace(actionAnchor, `${actionAnchor}${actionGuard}`);
  const managedStatus = `          if (${MANAGED_MARKER}) {
            await showStatus(state, commandCtx);
            break;
          }
`;
  const statusAnchor = "        case \"status\":\n        case \"\":\n        default:\n          if (commandCtx.hasUI) {\n";
  if (!nextIndex.includes(statusAnchor)) throw new Error("pi_mcp_adapter_status_anchor_missing");
  nextIndex = nextIndex.replace(statusAnchor, `        case "status":\n        case "":\n        default:\n${managedStatus}          if (commandCtx.hasUI) {\n`);

  const authHandlerAnchor = `  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const commandOwner = currentOwner;`;
  if (!nextIndex.includes(authHandlerAnchor)) throw new Error("pi_mcp_adapter_auth_handler_anchor_missing");
  const authGuard = `      if (${MANAGED_MARKER}) {
        if (ctx.hasUI) ctx.ui?.notify(MAPACHE_MANAGED_MCP_REFUSAL, "info");
        return;
      }
`;
  nextIndex = nextIndex.replace(authHandlerAnchor, `${authHandlerAnchor}\n${authGuard}`);

  const configPrelude = `
const ${MANAGED_MARKER} = (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "1" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "true" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "yes" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "on";
`;
  const guardedWriter = `${configPrelude}\n${configAnchor}\n  if (${MANAGED_MARKER}) throw new Error(${JSON.stringify(MANAGED_REFUSAL)});`;
  const nextConfig = configSource.replace(configAnchor, guardedWriter);

  const bearerPrelude = `
const ${MANAGED_MARKER} = (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "1" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "true" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "yes" ||
  (process.env.PI_WEB_MANAGED ?? "").trim().toLowerCase() === "on";

function assertManagedMcpCredentialMutationAllowed(): void {
  if (${MANAGED_MARKER}) throw new Error(${JSON.stringify(MANAGED_REFUSAL)});
}
`;
  let nextBearerStore = bearerStoreSource.replace(bearerWriteAnchor, `${bearerPrelude}\n${bearerWriteAnchor}\n  assertManagedMcpCredentialMutationAllowed();`);
  nextBearerStore = nextBearerStore.replace(bearerRemoveAnchor, `${bearerRemoveAnchor}\n  assertManagedMcpCredentialMutationAllowed();`);

  fsModule.writeFileSync(indexPath, nextIndex, "utf8");
  fsModule.writeFileSync(configPath, nextConfig, "utf8");
  fsModule.writeFileSync(bearerStorePath, nextBearerStore, "utf8");
  return {patched: true, packageRoot};
}

if (require.main === module) {
  const result = patchPiMcpAdapter();
  if (result.reason === "managed_package_missing") {
    throw new Error(`pi_mcp_adapter_package_missing: ${result.packageRoot}`);
  }
  console.log(`patched managed MCP policy in ${result.packageRoot}`);
}

module.exports = {patchPiMcpAdapter};
