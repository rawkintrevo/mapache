import assert from "node:assert/strict";
import test from "node:test";
import {CONFIRMATION, PROJECT_ID, parseArgs} from "./workspace-storage-recovery.mjs";

test("recovery CLI requires the explicit project, owner, workspace, and reservation", () => {
  assert.deepEqual(parseArgs([
    "list",
    `--project=${PROJECT_ID}`,
    "--uid", "owner-1",
    "--workspace-id=workspace-1",
    "--reservation-id=reservation-1",
  ]), {
    command: "list",
    project: PROJECT_ID,
    uid: "owner-1",
    "workspace-id": "workspace-1",
    "reservation-id": "reservation-1",
  });
  assert.throws(() => parseArgs(["list", "--project=wrong", "--uid", "owner-1", "--workspace-id", "workspace-1", "--reservation-id", "r"]), /project must be/);
});

test("restore and tree recovery require explicit target confirmation", () => {
  assert.throws(() => parseArgs([
    "restore", `--project=${PROJECT_ID}`, "--uid", "owner-1", "--workspace-id", "workspace-1",
    "--reservation-id", "r", "--object-path", "a.txt", "--generation", "7",
  ]), /confirm=/);
  assert.deepEqual(parseArgs([
    "recover-tree", `--project=${PROJECT_ID}`, "--uid", "owner-1", "--workspace-id", "workspace-1",
    "--reservation-id", "r", "--manifest", "manifest.json", `--confirm=${CONFIRMATION}`,
  ]).manifest, "manifest.json");
});
