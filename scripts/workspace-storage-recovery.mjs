import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";

export const PROJECT_ID = "pi-agents-cloud";
export const CONFIRMATION = "workspace-storage-recovery";

const functionsRequire = createRequire(new URL("../functions/package.json", import.meta.url));

export function parseArgs(argv = []) {
  const [command = "", ...rest] = argv;
  if (!["check", "reserve", "list", "restore", "recover-tree", "release"].includes(command)) {
    throw new Error("command must be check, reserve, list, restore, recover-tree, or release");
  }
  const values = {command};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = String(rest[index] || "");
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : rest[++index];
    if (!key || value === undefined || String(value).startsWith("--")) throw new Error(`missing value for --${key}`);
    if (!["confirm", "generation", "manifest", "object-path", "page-token", "prefix", "project", "reservation-id", "restore-token", "uid", "workspace-id"].includes(key)) {
      throw new Error(`unsupported option: --${key}`);
    }
    values[key] = String(value);
  }
  if (values.project !== PROJECT_ID) throw new Error(`project must be ${PROJECT_ID}`);
  for (const [value, label] of [[values.uid, "--uid"], [values["workspace-id"], "--workspace-id"]]) {
    if (!String(value || "").trim()) throw new Error(`${label} is required`);
  }
  if (["list", "restore", "recover-tree", "release"].includes(command) && !values["reservation-id"]) {
    throw new Error("--reservation-id is required while a maintenance reservation is held");
  }
  if (command === "restore" && (!values["object-path"] || !values.generation)) {
    throw new Error("restore requires --object-path and --generation");
  }
  if (command === "recover-tree" && !values.manifest) throw new Error("recover-tree requires --manifest");
  if (["restore", "recover-tree", "release"].includes(command) && values.confirm !== CONFIRMATION) {
    throw new Error(`--confirm=${CONFIRMATION} is required for this mutation`);
  }
  return values;
}

export async function runCommand(argv, dependencies = {}) {
  const args = parseArgs(argv);
  const service = dependencies.service || await defaultService();
  const uid = args.uid;
  const workspaceId = args["workspace-id"];
  if (args.command === "check") return service.checkRetention(uid, workspaceId, {prefix: args.prefix});
  if (args.command === "reserve") return service.acquireMaintenanceReservation(uid, workspaceId);
  if (args.command === "list") return service.listRecoverableGenerations(uid, workspaceId, {
    pageToken: args["page-token"],
    prefix: args.prefix,
    reservationId: args["reservation-id"],
  });
  if (args.command === "restore") return service.restoreGeneration(uid, workspaceId, args["reservation-id"], {
    generation: args.generation,
    objectPath: args["object-path"],
    restoreToken: args["restore-token"],
  });
  if (args.command === "recover-tree") {
    const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
    return service.recoverTree(uid, workspaceId, args["reservation-id"], manifest, {treePrefix: args.prefix});
  }
  return service.releaseMaintenanceReservation(uid, workspaceId, args["reservation-id"]);
}

async function defaultService() {
  const {getApps, initializeApp} = functionsRequire("firebase-admin/app");
  const {getFirestore} = functionsRequire("firebase-admin/firestore");
  const {getStorage} = functionsRequire("firebase-admin/storage");
  const app = getApps().length ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  const {createWorkspaceStorageBackupService} = functionsRequire("./workspaceStorageBackup.service");
  return createWorkspaceStorageBackupService({
    admin: functionsRequire("firebase-admin"),
    db: getFirestore(app),
    projectId: PROJECT_ID,
    storage: getStorage(app),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result?.compliant === false) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${error.code || "workspace_storage_recovery_failed"}: ${error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
