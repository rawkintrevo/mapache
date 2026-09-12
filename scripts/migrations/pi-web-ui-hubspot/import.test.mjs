import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import test from "node:test";
import {
  createPiSdkHistoryValidator,
  importHubspotBackup,
  validateImportPlan,
  verifyHubspotBackup,
} from "./import.mjs";
import {runImportCli} from "./import-cli.mjs";
import {exportHubspotBackup, parseInventory, validateExportPlan} from "../../hubspotPiWebExport.mjs";

const INVENTORY = `
- Workspace ID: \`workspace-source\`
- Owner UID: \`owner-source\`
- Workspace storage prefix: \`workspaces/owner-source/hubspot\`
- Session ID: \`session-source\`
- Session archive prefix: \`workspaces/owner-source/hubspot/.mapache-internal/sessions/session-source/pi-session\`
`;

const SDK_PATH = path.join(
  process.env.PI_WEB_SDK_ROOT || "/home/rawkintrevo/.nvm/versions/node/v24.6.0/lib/node_modules/@earendil-works/pi-coding-agent",
  "dist",
  "index.js",
);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-hubspot-import-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspace = path.join(root, "workspace");
  const sourceSession = path.join(root, "session-source");
  const attachments = path.join(root, "attachments");
  const backup = path.join(root, "backup");
  await fs.mkdir(path.join(workspace, ".pi", "agent"), {recursive: true});
  await fs.mkdir(sourceSession, {recursive: true});
  await fs.mkdir(path.join(attachments, "uploads"), {recursive: true});
  await fs.writeFile(path.join(workspace, "README.md"), "workspace\n");
  await fs.writeFile(path.join(workspace, ".pi", "agent", "settings.json"), JSON.stringify({
    packages: ["npm:pi-mcp-adapter@2.32.1", "npm:pi-goal-x@0.31.2"],
    launches: [{name: "pi-goal-x", command: "pi-goal-x"}],
  }));
  await fs.writeFile(path.join(attachments, "uploads", "image.bin"), Buffer.from([0, 255, 1]));
  await fs.writeFile(path.join(sourceSession, "conversation.jsonl"), [
    JSON.stringify({type: "session", version: 3, id: "conversation-session", timestamp: "2026-09-11T00:00:00.000Z", cwd: workspace}),
    JSON.stringify({type: "message", id: "root", parentId: null, timestamp: "2026-09-11T00:00:01.000Z", message: {role: "user", content: [{type: "text", text: "<file path=\"uploads/image.bin\" />"}]}}),
    JSON.stringify({type: "branch", id: "branch-a", parentId: "root", timestamp: "2026-09-11T00:00:02.000Z"}),
  ].join("\n") + "\n");
  const exportPlan = validateExportPlan({
    inventory: parseInventory(INVENTORY),
    ownerUid: "owner-source",
    outputPrefix: backup,
    sessionId: "session-source",
    sourcePrefix: "workspaces/owner-source/hubspot",
    workspaceId: "workspace-source",
  });
  await exportHubspotBackup({
    attachmentsRoot: attachments,
    controller: {
      async quiesce() { return {quiesced: true, activeWriters: 0}; },
      async stop() { return {stopped: true}; },
    },
    outputRoot: backup,
    plan: exportPlan,
    sessionRoot: sourceSession,
    workspaceRoot: workspace,
  });
  return {backup, root, sourceWorkspace: workspace};
}

function importPlan(backup, root, overrides = {}) {
  return validateImportPlan({
    backupRoot: backup,
    manifest: overrides.manifest,
    targetOwnerUid: "owner-source",
    targetPrefix: "workspaces/owner-source/hubspot-pi-web",
    targetSessionId: "session-target",
    targetSessionRoot: path.join(root, "target", "sessions"),
    targetPiRoot: path.join(root, "target", "pi"),
    targetUiRoot: path.join(root, "target", "ui"),
    targetWorkspaceId: "workspace-target",
    targetWorkspaceRoot: path.join(root, "target", "workspace"),
    ...overrides,
  });
}

async function sdkValidator(plan) {
  const sdk = await import(pathToFileURL(SDK_PATH).href);
  return createPiSdkHistoryValidator({sdkModule: sdk, sessionRoot: plan.target.sessions, workspaceRoot: plan.target.workspace});
}

test("verifies the export manifest and rejects source-target identity or path collisions", async (t) => {
  const {backup, root} = await fixture(t);
  const verified = await verifyHubspotBackup({backupRoot: backup});
  const plan = importPlan(backup, root, {manifest: verified.manifest});
  assert.equal(plan.target.sessionId, "session-target");
  assert.throws(() => importPlan(backup, root, {manifest: verified.manifest, targetSessionId: "session-source"}), (error) => error.code === "source_target_identity_collision");
  assert.throws(() => importPlan(backup, root, {manifest: verified.manifest, targetPrefix: "workspaces/owner-source/hubspot/export"}), (error) => error.code === "source_target_prefix_collision");
  assert.throws(() => importPlan(backup, root, {manifest: verified.manifest, targetWorkspaceRoot: backup}), (error) => error.code === "backup_target_path_collision");
});

test("CLI defaults to a verified no-write plan", async (t) => {
  const {backup, root} = await fixture(t);
  const result = await runImportCli([
    "--backup-root", backup,
    "--sdk-module", SDK_PATH,
    "--target-owner-uid", "owner-source",
    "--target-prefix", "workspaces/owner-source/hubspot-pi-web",
    "--target-workspace-id", "workspace-target",
    "--target-session-id", "session-target",
    "--target-workspace-root", path.join(root, "target", "workspace"),
    "--target-session-root", path.join(root, "target", "sessions"),
    "--target-pi-root", path.join(root, "target", "pi"),
    "--target-ui-root", path.join(root, "target", "ui"),
  ]);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.writes, "none");
  await assert.rejects(fs.access(path.join(root, "target")));
});

test("imports exact files and history, transforms only copied Pi settings, and is idempotent", async (t) => {
  const {backup, root} = await fixture(t);
  const verified = await verifyHubspotBackup({backupRoot: backup});
  const plan = importPlan(backup, root, {manifest: verified.manifest});
  const historySdk = await sdkValidator(plan);
  const imported = await importHubspotBackup({backupRoot: backup, historySdk, plan, now: () => "stable"});
  assert.equal(imported.status, "imported");
  assert.equal(imported.history.openedFiles, 1);
  assert.equal(imported.history.branches, 1);
  assert.equal(imported.intentionalConfigChanges.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(plan.target.pi, "settings.json"), "utf8")), {
    packages: ["npm:pi-mcp-adapter@2.32.1"],
    launches: [],
  });
  assert.equal(await fs.readFile(path.join(plan.target.workspace, "README.md"), "utf8"), "workspace\n");
  assert.deepEqual(await fs.readFile(path.join(plan.target.ui, "uploads", "image.bin")), Buffer.from([0, 255, 1]));
  assert.equal(await fs.readFile(path.join(plan.target.sessions, "conversation.jsonl"), "utf8"), await fs.readFile(path.join(backup, "sessions", "session-source", "conversation.jsonl"), "utf8"));
  const repeated = await importHubspotBackup({backupRoot: backup, historySdk, plan, now: () => "stable"});
  assert.equal(repeated.status, "idempotent");
  assert.deepEqual(repeated.files, imported.files);
});

test("verify-only validates an installed target and refuses new target work", async (t) => {
  const {backup, root} = await fixture(t);
  const verified = await verifyHubspotBackup({backupRoot: backup});
  const plan = importPlan(backup, root, {manifest: verified.manifest});
  const historySdk = await sdkValidator(plan);
  await assert.rejects(importHubspotBackup({backupRoot: backup, historySdk, plan, verifyOnly: true}), (error) => error.code === "target_not_imported");
  await importHubspotBackup({backupRoot: backup, historySdk, plan});
  await fs.writeFile(path.join(plan.target.workspace, "new-work.txt"), "do not overwrite\n");
  await assert.rejects(importHubspotBackup({backupRoot: backup, historySdk, plan}), (error) => error.code === "target_not_empty");
  await assert.rejects(importHubspotBackup({backupRoot: backup, historySdk, plan, verifyOnly: true}), (error) => error.code === "target_not_imported");
});

test("blocks malformed interior history and unsafe backup symlinks", async (t) => {
  const {backup, root} = await fixture(t);
  const manifestPath = path.join(backup, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const history = manifest.files.find((record) => record.category === "history");
  const historyPath = path.join(backup, history.backupPath);
  const content = await fs.readFile(historyPath, "utf8");
  await fs.writeFile(historyPath, `${content.split("\n")[0]}\nnot-json\n${content.split("\n").slice(1).join("\n")}`);
  await assert.rejects(verifyHubspotBackup({backupRoot: backup}), (error) => error.code === "backup_checksum_mismatch");
  await fs.writeFile(historyPath, content);
  const restored = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const unsigned = {...restored};
  delete unsigned.manifestSha256;
  const checksum = (await import("node:crypto")).createHash("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
  restored.manifestSha256 = checksum;
  await fs.writeFile(manifestPath, `${JSON.stringify(restored, null, 2)}\n`);
  await fs.writeFile(path.join(backup, "manifest.sha256"), `${checksum}\n`);
  await fs.symlink("../../outside", path.join(backup, "workspace", "unsafe-link"));
  await assert.rejects(verifyHubspotBackup({backupRoot: backup}), (error) => error.code === "backup_unlisted_file");
  assert.equal(path.basename(root), path.basename(root));
});
