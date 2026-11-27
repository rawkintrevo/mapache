"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {guestConfiguration, guestConfigurationId, workspaceHostname} = require("./remoteVmGuestConfig.helpers");

test("guest configuration excludes host keys and has the same identity in JS and Python", () => {
  const session = {ownerUid: "owner-1", browserAccessTokenSecret: "a".repeat(64), shutdownToken: "b".repeat(48),
    privateKey: "HOST-KEY-MUST-NOT-LEAVE-CONTROL-PLANE"};
  const options = {session, sessionId: "session-1", descriptor: {workspaceId: "workspace-1", generation: 1}, bootId: "boot-1"};
  const configuration = guestConfiguration(options);
  assert.equal(JSON.stringify(configuration).includes(session.privateKey), false);
  assert.throws(() => guestConfiguration({...options, sessionId: "session\nPORT=22"}), /configuration_invalid/);
  assert.throws(() => guestConfiguration({...options, brokerUrl: "https://other.example"}), /configuration_invalid/);
  const pythonId = execFileSync("python3", ["-B", "-c",
    "import sys,json; sys.path.insert(0,sys.argv[1]); from mapache_guest_config import configuration_id; print(configuration_id(json.load(sys.stdin)))",
    path.resolve(__dirname, "../scripts/remote-vm-host")], {input: JSON.stringify(configuration), encoding: "utf8"}).trim();
  assert.equal(guestConfigurationId(configuration), pythonId);
});

test("workspace names become bounded single-label hostnames", () => {
  assert.equal(workspaceHostname("Tower3-personal"), "tower3-personal");
  assert.equal(workspaceHostname("  Team / Dev.Box  "), "team-dev-box");
  assert.equal(workspaceHostname("x".repeat(62) + " workspace"), "x".repeat(62));
  assert.equal(workspaceHostname("a".repeat(100)), "a".repeat(63));
  assert.equal(workspaceHostname("🌲"), "");
  assert.equal(workspaceHostname(undefined), "");
});
