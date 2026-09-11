import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { AGENT_UI_VERSION } = require("../functions/agentRuntime.helpers.js");

const PROJECT_ID = "pi-agents-cloud";

/** Build the only workspace mutation this deployment helper is allowed to make. */
function buildMarkerUpdate({ serverTimestamp, actor = "deployment-admin" } = {}) {
  if (serverTimestamp === undefined) throw new Error("server timestamp is required");
  const markedBy = String(actor || "deployment-admin").replace(/[^A-Za-z0-9_.@:-]/g, "_").slice(0, 128);
  return {
    agentUiVersion: AGENT_UI_VERSION,
    agentRollout: {
      markedAt: serverTimestamp,
      markedBy: markedBy || "deployment-admin",
      purpose: "qa",
    },
  };
}

/** Mark one explicitly named, owner-verified QA workspace through Admin SDK. */
async function markAgentWorkspace({ db, fieldValue, uid, workspaceId, actor } = {}) {
  const ownerUid = requiredValue(uid, "owner UID");
  const targetWorkspaceId = requiredValue(workspaceId, "workspace ID");
  if (!db || typeof db.collection !== "function" || typeof fieldValue?.serverTimestamp !== "function") {
    throw new Error("Admin Firestore dependencies are required");
  }
  const workspaceRef = db.collection("workspaces").doc(targetWorkspaceId);
  let owner;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(workspaceRef);
    if (!snapshot.exists) throw new Error("qa_workspace_not_found");
    const workspace = snapshot.data() || {};
    if (workspace.ownerUid !== ownerUid) throw new Error("qa_workspace_owner_mismatch");
    owner = workspace.ownerUid;
    transaction.update(workspaceRef, buildMarkerUpdate({
      actor,
      serverTimestamp: fieldValue.serverTimestamp(),
    }));
  });
  return {agentUiVersion: AGENT_UI_VERSION, ownerUid: owner, workspaceId: targetWorkspaceId};
}

function parseMarkerArgs(argv = []) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (!key || value === undefined || String(value).startsWith("--")) throw new Error(`missing value for --${key}`);
    if (!["actor", "confirm-qa", "project", "uid", "workspace-id"].includes(key)) {
      throw new Error(`unsupported option: --${key}`);
    }
    values[key] = String(value);
  }
  return values;
}

function requiredValue(value, label) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error(`${label} is required`);
  return clean;
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseMarkerArgs(argv);
  if ((args.project || PROJECT_ID) !== PROJECT_ID) throw new Error(`project must be ${PROJECT_ID}`);
  if (args["confirm-qa"] !== AGENT_UI_VERSION) {
    throw new Error(`--confirm-qa=${AGENT_UI_VERSION} is required`);
  }
  const functionsRequire = createRequire(new URL("../functions/package.json", import.meta.url));
  const { getApps, initializeApp } = functionsRequire("firebase-admin/app");
  const { getFirestore, FieldValue } = functionsRequire("firebase-admin/firestore");
  const app = getApps().length ? getApps()[0] : initializeApp({ projectId: PROJECT_ID });
  const result = await markAgentWorkspace({
    actor: args.actor,
    db: getFirestore(app),
    fieldValue: FieldValue,
    uid: requiredValue(args.uid, "--uid"),
    workspaceId: requiredValue(args["workspace-id"], "--workspace-id"),
  });
  console.log(JSON.stringify(result));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

export { AGENT_UI_VERSION, PROJECT_ID, buildMarkerUpdate, markAgentWorkspace, parseMarkerArgs, runCli };
