import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {
  DEFAULT_INVENTORY_PATH,
  buildDryRunPlan,
  exportHubspotBackup,
  parseInventory,
  validateExportPlan,
} from "./hubspotPiWebExport.mjs";

export function parseExportArgs(argv = []) {
  const values = {inventory: DEFAULT_INVENTORY_PATH, execute: false};
  const supported = new Set([
    "attachments-root", "controller-module", "execute", "inventory", "output-prefix",
    "owner-uid", "session-id", "session-root", "source-prefix", "source-root", "workspace-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    if (!supported.has(key)) throw new Error(`unsupported option: --${key}`);
    if (key === "execute") {
      if (equals >= 0) throw new Error("--execute does not take a value");
      values.execute = true;
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (value === undefined || String(value).startsWith("--") || !String(value).trim()) {
      throw new Error(`missing value for --${key}`);
    }
    values[key] = String(value);
  }
  return values;
}

export async function runCli(argv = process.argv.slice(2), io = console) {
  const args = parseExportArgs(argv);
  const inventoryText = await readFile(path.resolve(args.inventory), "utf8");
  const plan = validateExportPlan({
    inventory: parseInventory(inventoryText),
    ownerUid: args["owner-uid"],
    outputPrefix: args["output-prefix"],
    sessionId: args["session-id"],
    sourcePrefix: args["source-prefix"],
    sourceRoot: args["source-root"],
    workspaceId: args["workspace-id"],
  });
  if (!args.execute) {
    const result = buildDryRunPlan(plan);
    io.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (!args["source-root"] || !args["session-root"] || !args["controller-module"]) {
    throw new Error("--execute requires --source-root, --session-root, and --controller-module");
  }
  const controllerModule = await import(pathToFileURL(path.resolve(args["controller-module"])).href);
  const controller = controllerModule.default || controllerModule.controller || controllerModule;
  const result = await exportHubspotBackup({
    attachmentsRoot: args["attachments-root"],
    controller,
    outputRoot: args["output-prefix"],
    plan,
    sessionRoot: args["session-root"],
    workspaceRoot: args["source-root"],
  });
  io.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runCli().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

export const scriptPath = fileURLToPath(import.meta.url);
