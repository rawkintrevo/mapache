import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_UI_VERSION,
  PROJECT_ID,
  buildMarkerUpdate,
  markAgentWorkspace,
  parseMarkerArgs,
} from "./mark-agent-workspace.mjs";

test("marker CLI requires an explicit project, QA confirmation, owner, and workspace", () => {
  assert.deepEqual(parseMarkerArgs([
    "--project=pi-agents-cloud",
    "--confirm-qa=pi-web-ui-v1",
    "--uid", "owner-1",
    "--workspace-id=qa-1",
  ]), {
    "confirm-qa": AGENT_UI_VERSION,
    project: PROJECT_ID,
    uid: "owner-1",
    "workspace-id": "qa-1",
  });
  assert.throws(() => parseMarkerArgs(["--image", "pi-chrome"]), /unsupported option/);
});

test("marker update is fixed to the managed QA version", () => {
  assert.deepEqual(buildMarkerUpdate({actor: "admin@example.com", serverTimestamp: "SERVER_TIMESTAMP"}), {
    agentUiVersion: AGENT_UI_VERSION,
    agentRollout: {
      markedAt: "SERVER_TIMESTAMP",
      markedBy: "admin@example.com",
      purpose: "qa",
    },
  });
});

test("marker transaction verifies the named workspace owner", async () => {
  const updates = [];
  const workspaceRef = {id: "qa-1"};
  const db = {
    collection: (name) => {
      assert.equal(name, "workspaces");
      return {doc: (id) => {
        assert.equal(id, "qa-1");
        return workspaceRef;
      }};
    },
    runTransaction: async (callback) => callback({
      get: async () => ({exists: true, data: () => ({ownerUid: "owner-1"})}),
      update: (ref, update) => updates.push({ref, update}),
    }),
  };
  const result = await markAgentWorkspace({
    db,
    fieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"},
    uid: "owner-1",
    workspaceId: "qa-1",
  });
  assert.deepEqual(result, {agentUiVersion: AGENT_UI_VERSION, ownerUid: "owner-1", workspaceId: "qa-1"});
  assert.equal(updates.length, 1);
  await assert.rejects(
      markAgentWorkspace({
        db: {
          ...db,
          runTransaction: async (callback) => callback({
            get: async () => ({exists: true, data: () => ({ownerUid: "other-owner"})}),
            update: () => assert.fail("owner mismatch must not update"),
          }),
        },
        fieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"},
        uid: "owner-1",
        workspaceId: "qa-1",
      }),
      /qa_workspace_owner_mismatch/,
  );
});
