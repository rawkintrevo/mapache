import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDryRunPlan,
  exportHubspotBackup,
  parseInventory,
  validateExportPlan,
} from "./hubspotPiWebExport.mjs";
import {parseExportArgs} from "./hubspot-pi-web-export.mjs";

const INVENTORY = `
- Workspace ID: \`workspace-source\`
- Owner UID: \`owner-source\`
- Workspace storage prefix: \`workspaces/owner-source/hubspot\`
- Session ID: \`session-source\`
- Session archive prefix: \`workspaces/owner-source/hubspot/.mapache-internal/sessions/session-source/pi-session\`
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-hubspot-export-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspace = path.join(root, "workspace");
  const session = path.join(root, "session-source");
  const attachments = path.join(root, "attachments");
  await fs.mkdir(path.join(workspace, ".git", "refs", "heads"), {recursive: true});
  await fs.mkdir(path.join(workspace, ".mapache-internal", "chrome"), {recursive: true});
  await fs.mkdir(session, {recursive: true});
  await fs.mkdir(path.join(attachments, "uploads"), {recursive: true});
  await fs.writeFile(path.join(workspace, "README.md"), "workspace\n");
  await fs.writeFile(path.join(workspace, ".env.example"), "BINARY_PLACEHOLDER\n");
  await fs.writeFile(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(workspace, ".git", "refs", "heads", "main"), "abc123\n");
  await fs.writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 255, 1, 254]));
  await fs.writeFile(path.join(workspace, ".mapache-internal", "chrome", "chrome-profile.tar.gz"), "must skip");
  await fs.writeFile(path.join(attachments, "uploads", "large.bin"), Buffer.from([255, 0, 255, 0, 42]));
  await fs.writeFile(path.join(session, "conversation.jsonl"), [
    JSON.stringify({type: "session", id: "branch-root"}),
    JSON.stringify({type: "message", message: {role: "user", content: [{type: "text", text: "<file path=\"uploads/large.bin\" size=5 />"}]}}),
    JSON.stringify({type: "branch", id: "branch-a", parentId: "branch-root"}),
  ].join("\n") + "\n" + JSON.stringify({type: "message", message: {role: "assistant", content: [{type: "text", text: "partial"}]}}).slice(0, -1));
  await fs.writeFile(path.join(session, "other-state.json"), "skip me");
  return {attachments, root, session, workspace};
}

function planFor(outputPrefix, overrides = {}) {
  return validateExportPlan({
    inventory: parseInventory(INVENTORY),
    ownerUid: "owner-source",
    outputPrefix,
    sessionId: "session-source",
    sourcePrefix: "workspaces/owner-source/hubspot",
    workspaceId: "workspace-source",
    ...overrides,
  });
}

test("parses explicit args and builds a no-write dry-run plan", () => {
  const args = parseExportArgs([
    "--owner-uid", "owner-source",
    "--workspace-id=workspace-source",
    "--session-id", "session-source",
    "--source-prefix", "workspaces/owner-source/hubspot",
    "--output-prefix", "/tmp/hubspot-backup",
  ]);
  assert.equal(args.execute, false);
  const plan = planFor(args["output-prefix"]);
  assert.equal(buildDryRunPlan(plan).writes, "none");
});

test("exports hidden workspace files, git, binary bytes, selected history, and referenced attachments", async (t) => {
  const {attachments, root, session, workspace} = await fixture(t);
  const output = path.join(root, "backup");
  const calls = [];
  const result = await exportHubspotBackup({
    attachmentsRoot: attachments,
    controller: {
      async quiesce() {
        calls.push("quiesce");
        return {quiesced: true, activeConversations: 0, activeTools: 0, pendingMessages: 0};
      },
      async stop() {
        calls.push("stop");
        return {stopped: true};
      },
    },
    outputRoot: output,
    plan: planFor(output),
    sessionRoot: session,
    workspaceRoot: workspace,
  });
  assert.deepEqual(calls, ["quiesce", "stop"]);
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(output, "workspace", "binary.bin"), "hex"), "00ff01fe");
  assert.equal(await fs.readFile(path.join(output, "workspace", ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.equal(await fs.readFile(path.join(output, "attachments", "uploads", "large.bin"), "hex"), "ff00ff002a");
  assert.equal(await fs.readFile(path.join(output, "sessions", "session-source", "conversation.jsonl"), "utf8"),
      await fs.readFile(path.join(session, "conversation.jsonl"), "utf8"));
  await assert.rejects(fs.access(path.join(output, "workspace", ".mapache-internal", "chrome", "chrome-profile.tar.gz")));
  await assert.rejects(fs.access(path.join(output, "sessions", "session-source", "other-state.json")));
  const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
  const history = manifest.files.find((entry) => entry.sourcePath === "sessions/session-source/conversation.jsonl");
  assert.equal(history.trailingIncomplete, true);
  assert.equal(history.completeRecords, false);
  assert.equal(manifest.policy.sourceWasStopped, true);
  assert.equal(manifest.files.some((entry) => entry.sourcePath === "workspace/binary.bin" && entry.byteLength === 4), true);
  assert.equal(manifest.files.some((entry) => entry.sourcePath === "attachments/uploads/large.bin" && entry.action === "copy"), true);
  assert.match(manifest.manifestSha256, /^[a-f0-9]{64}$/);
});

test("refuses a non-quiescent source before creating output", async (t) => {
  const {root, session, workspace} = await fixture(t);
  const output = path.join(root, "backup");
  let stopped = false;
  await assert.rejects(
      exportHubspotBackup({
        outputRoot: output,
        plan: planFor(output),
        sessionRoot: session,
        workspaceRoot: workspace,
        controller: {
          async quiesce() { return {quiesced: true, activeTools: 1}; },
          async stop() { stopped = true; return {stopped: true}; },
        },
      }),
      (error) => error.code === "source_not_quiescent",
  );
  assert.equal(stopped, false);
  await assert.rejects(fs.access(output));
});

test("rejects source mapping mismatches and prefix collisions", () => {
  assert.throws(() => planFor("workspaces/owner-source/hubspot/export"), (error) => error.code === "source_output_prefix_collision");
  assert.throws(() => validateExportPlan({
    inventory: parseInventory(INVENTORY),
    ownerUid: "wrong-owner",
    outputPrefix: "/tmp/backup",
    sessionId: "session-source",
    sourcePrefix: "workspaces/owner-source/hubspot",
    workspaceId: "workspace-source",
  }), (error) => error.code === "source_mapping_mismatch");
});
