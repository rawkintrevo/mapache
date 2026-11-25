import assert from "node:assert/strict";
import test from "node:test";
import {parseArgs, parseRemoteEvidence, recoveryDescriptor, runtimeStateDigest} from "./vm-backup-recovery-proof.mjs";

const image = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:" + "a".repeat(64);

test("backup recovery proof requires an exact pinned image and explicit confirmation", () => {
  assert.throws(() => parseArgs(["--project", "pi-agents-cloud", "--workspace", "ws", "--owner", "owner", "--backup", "backup", "--runner-image", image]), /confirmation/);
  const options = parseArgs(["--project=pi-agents-cloud", "--workspace=ws", "--owner=owner", "--backup=backup",
    `--runner-image=${image}`, "--confirm-recovery"]);
  assert.equal(options.timeoutMs, 10 * 60 * 1000);
});

test("recovery descriptor and remote evidence stay bound to workspace and session", () => {
  const descriptor = recoveryDescriptor({workspaceId: "ws", ownerUid: "owner", sourceGeneration: 3,
    region: "us-central1", zone: "us-central1-a", diskName: "mapache-restore-abc", operationId: "operation-1"});
  assert.match(descriptor.instanceName, /^mapache-restore-[a-f0-9]{24}$/);
  const health = {ok: true, workspaceId: "ws", sessionId: "recovery-123456789012345678901234",
    agentRuntime: {ready: true, state: "ready", health: {ready: true, engine: "pi", build: {packageVersion: "1", upstreamCommit: "commit"}}}};
  const digest = {ok: true, workspaceId: "ws", sessionId: health.sessionId, fileDigest: "sha256:" + "b".repeat(64), entryCount: 3, byteCount: 20};
  const evidence = parseRemoteEvidence(`MAPACHE_HEALTH ${JSON.stringify(health)}\nMAPACHE_DIGEST ${JSON.stringify(digest)}`, {workspaceId: "ws", sessionId: health.sessionId});
  assert.equal(evidence.runtimeReady, true);
  assert.match(runtimeStateDigest(health), /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => parseRemoteEvidence(`MAPACHE_HEALTH ${JSON.stringify({...health, workspaceId: "other"})}\nMAPACHE_DIGEST ${JSON.stringify(digest)}`, {workspaceId: "ws", sessionId: health.sessionId}), /not_ready/);
});
