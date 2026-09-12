import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import test from "node:test";
import {assertRuntimeReady, toRunnerFsImpl} from "./cutover.mjs";

const require = createRequire(import.meta.url);
const {createAgentSnapshotService} = require("../../../session-runner/lib/agentSnapshot.service.js");

test("adapts promise-only migration fs for session-runner snapshot services", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-hubspot-cutover-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const stagingDir = path.join(root, "staging");
  const runnerFs = toRunnerFsImpl(fs);
  const service = createAgentSnapshotService({
    config: {
      agentRuntimeEnabled: true,
      internalStorageDir: ".mapache-internal",
      prefix: "workspaces/owner/workspace",
      workspaceId: "workspace",
      sessionId: "session",
    },
    fsImpl: runnerFs,
  });

  const capture = await service.capture({
    bootInstanceId: "boot",
    generation: 1,
    sessionId: "session",
    stagingDir,
    workspaceId: "workspace",
  });

  assert.equal(runnerFs.promises, fs);
  assert.equal(capture.manifest.kind, "mapache-agent-state-snapshot");
  assert.equal(await fs.stat(path.join(stagingDir, "manifest.json")).then((stat) => stat.isFile()), true);
});

test("rejects a restart result that did not produce a running immutable runtime", () => {
  assert.throws(
    () => assertRuntimeReady({status: "provision_failed", runtimeState: "failed"}, "image"),
    (error) => error.code === "runtime_not_ready",
  );
  assert.doesNotThrow(() => assertRuntimeReady({
    status: "running",
    runtimeState: "running",
    serviceUrl: "https://runner.invalid",
    runnerImageDigest: "image",
    runnerImageCurrentDigest: "image",
  }, "image"));
});
