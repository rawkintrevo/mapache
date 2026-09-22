"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const {assertAutomationStorageMounts, automationPrompt} = require("./automationStorage.helpers");
const config = {runtimeKind: "automation", workspaceStorageMode: "automation-readonly-gcs-v1", workspaceDir: "/workspace", automationOutputDir: "/automation-output/11111111-1111-4111-8111-111111111111"};

test("requires a read-only input mount and writable persistent output mount", async () => {
  const writes = [];
  const fsImpl = {promises: {
    statfs: async () => ({type: 0x65735546}),
    writeFile: async (name) => {
      writes.push(name);
      if (name.startsWith("/workspace/")) throw Object.assign(new Error("read only"), {code: "EROFS"});
    },
    unlink: async () => {},
  }};
  await assertAutomationStorageMounts(config, {fsImpl});
  assert.equal(writes.length, 2);
  assert.ok(writes[1].startsWith(config.automationOutputDir));
  fsImpl.promises.writeFile = async () => {};
  await assert.rejects(assertAutomationStorageMounts(config, {fsImpl}), {code: "automation_workspace_not_read_only"});
  fsImpl.promises.statfs = async () => ({type: 0x01021994});
  await assert.rejects(assertAutomationStorageMounts(config, {fsImpl}), {code: "automation_storage_mount_missing"});
});

test("informs the automation about input and output while preserving the user's prompt", () => {
  const prompt = automationPrompt("Summarize my files", config);
  assert.ok(prompt.includes("read-only at /workspace"));
  assert.ok(prompt.includes(config.automationOutputDir));
  assert.ok(prompt.endsWith("Summarize my files"));
  assert.equal(automationPrompt("original", {}), "original");
});
