import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {
  createPiSdkHistoryValidator,
  importHubspotBackup,
  validateImportPlan,
  verifyHubspotBackup,
} from "./import.mjs";

export function parseImportArgs(argv) {
  const args = {execute: false, verifyOnly: false};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--execute") {
      args.execute = true;
      continue;
    }
    if (token === "--verify-only") {
      args.verifyOnly = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const equal = token.indexOf("=");
    if (equal !== -1) {
      args[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    args[name] = value;
    index += 1;
  }
  if (args.execute && args.verifyOnly) throw new Error("--execute and --verify-only are mutually exclusive");
  return args;
}

function required(args, name) {
  if (!String(args[name] || "").trim()) throw new Error(`--${name} is required`);
  return args[name];
}

export async function runImportCli(argv = process.argv.slice(2)) {
  const args = parseImportArgs(argv);
  const backupRoot = required(args, "backup-root");
  const sdkModulePath = required(args, "sdk-module");
  const manifest = (await verifyHubspotBackup({backupRoot})).manifest;
  const plan = validateImportPlan({
    backupRoot,
    manifest,
    targetOwnerUid: required(args, "target-owner-uid"),
    targetPrefix: required(args, "target-prefix"),
    targetSessionId: required(args, "target-session-id"),
    targetSessionRoot: required(args, "target-session-root"),
    targetPiRoot: required(args, "target-pi-root"),
    targetUiRoot: required(args, "target-ui-root"),
    targetWorkspaceId: required(args, "target-workspace-id"),
    targetWorkspaceRoot: required(args, "target-workspace-root"),
  });
  const sdkModule = await import(pathToFileURL(path.resolve(sdkModulePath)).href);
  const historySdk = createPiSdkHistoryValidator({
    sdkModule,
    sessionRoot: plan.target.sessions,
    workspaceRoot: plan.target.workspace,
  });
  if (!args.execute && !args.verifyOnly) {
    return {
      mode: "dry-run",
      source: plan.source,
      target: plan.target,
      backupRoot: plan.backupRoot,
      controller: "not invoked",
      sdk: "not invoked",
      writes: "none",
    };
  }
  return importHubspotBackup({
    backupRoot,
    historySdk,
    plan,
    verifyOnly: args.verifyOnly,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runImportCli().then(async (result) => {
    if (process.argv.includes("--report")) {
      const reportIndex = process.argv.indexOf("--report");
      const reportPath = process.argv[reportIndex + 1];
      if (reportPath && result.mode !== "dry-run") await writeFile(path.resolve(reportPath), `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({error: error.code || "import_failed", message: error.message})}\n`);
    process.exitCode = 1;
  });
}
