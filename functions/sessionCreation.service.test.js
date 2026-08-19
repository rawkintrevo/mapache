"use strict";

const assert = require("assert");
const {createSessionCreationService} = require("./sessionCreation.service");

const serverTimestamp = () => "SERVER_TIMESTAMP";
const admin = {firestore: {FieldValue: {serverTimestamp}}};
const reservations = [];
let storedSession = null;
const sessionRef = {
  id: "operation-test-session",
  async get() {
    return storedSession ? {exists: true, id: this.id, data: () => storedSession} : {exists: false, id: this.id, data: () => ({})};
  },
};
const dependencies = {
  admin,
  db: {},
  normalizeRequestedSessionResources: () => ({cpu: "1", memory: "1Gi"}),
  releaseChromeWorkspaceSession: async (...args) => reservations.push({kind: "releaseChrome", args}),
  reserveChromeWorkspaceSession: async (...args) => {
    reservations.push({kind: "reserveChrome", args});
    storedSession = {...args[2], syncWriterRole: "writer"};
  },
  reserveGithubWorkspaceSession: async (...args) => {
    reservations.push({kind: "reserveGithub", args});
    storedSession = {...args[2], syncWriterRole: "writer"};
  },
  reserveWorkspaceSyncSession: async (...args) => {
    reservations.push({kind: "reserveSync", args});
    storedSession = {...args[2], syncWriterRole: "writer"};
  },
  resolveHarness: (harnessId) => ({terminalKind: harnessId === "codex" ? "codex" : harnessId === "ssh" ? "ssh" : "shell"}),
  resolveRunnerImage: (payload) => payload.imageKey === "chrome" ? {
    key: "chrome",
    image: "gcr.io/example/chrome",
    harnessId: "pi",
    terminalKind: "pi",
    capabilities: {terminal: true, preview: true, chrome: true},
    canProvision: true,
  } : {
    key: "default",
    image: "gcr.io/example/default",
    harnessId: "shell",
    terminalKind: "shell",
    capabilities: {terminal: true, preview: true},
    canProvision: true,
  },
  requireWorkspace: async (uid, workspaceId) => ({
    ownerUid: uid,
    id: workspaceId,
    bucket: "bucket",
    storagePrefix: `workspaces/${uid}/${workspaceId}`,
    source: {type: "blank"},
    mcpConfig: {},
  }),
  runnerServiceAccountValue: () => "runner@example.iam.gserviceaccount.com",
  sessionCollection: () => ({doc: () => sessionRef}),
};
const service = createSessionCreationService(dependencies);

async function createWithWorkspace(workspace, payload) {
  dependencies.requireWorkspace = async () => workspace;
  storedSession = null;
  reservations.length = 0;
  return service.createSession("user-1", "workspace-1", payload);
}

(async () => {
  const blank = await createWithWorkspace({
    ownerUid: "user-1",
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/blank",
    source: {type: "blank"},
    mcpConfig: {},
  }, {operationId: "blank-1", name: "Blank"});
  assert.strictEqual(blank.sourceType, "blank");
  assert.strictEqual(blank.status, "provisioning");
  assert.strictEqual(blank.provisioningState, "queued");
  assert.strictEqual(reservations[0].kind, "reserveSync");

  const github = await createWithWorkspace({
    ownerUid: "user-1",
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/github",
    source: {type: "github", mode: "connected", owner: "octo", repo: "mapache", connection: {installationId: "42", repoId: "99"}},
    mcpConfig: {},
  }, {operationId: "github-1"});
  assert.strictEqual(github.sourceType, "github");
  assert.strictEqual(github.sourceMode, "connected");
  assert.strictEqual(github.sourceInstallationId, "42");
  assert.strictEqual(reservations[0].kind, "reserveGithub");

  const chrome = await createWithWorkspace({
    ownerUid: "user-1",
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/chrome",
    source: {type: "blank"},
    mcpConfig: {},
  }, {operationId: "chrome-1", imageKey: "chrome"});
  assert.strictEqual(chrome.capabilities.chrome, true);
  assert.strictEqual(reservations[0].kind, "reserveChrome");
  assert.strictEqual(reservations[0].args[3].syncWriterEligible, true);

  const ssh = await createWithWorkspace({
    ownerUid: "user-1",
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/ssh",
    source: {type: "blank"},
    mcpConfig: {},
  }, {
    operationId: "ssh-1",
    type: "ssh",
    sshTarget: {
      host: "dev.example.com",
      port: 22,
      username: "developer",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
      knownHosts: "dev.example.com ssh-ed25519 AAAAhost",
    },
  });
  assert.strictEqual(ssh.sessionType, "ssh");
  assert.strictEqual(ssh.terminalKind, "ssh");
  assert.strictEqual(ssh.capabilities.sshFiles, true);
  assert.strictEqual(ssh.sessionEnv.SSH_TARGET_HOST, "dev.example.com");
  assert.strictEqual(reservations[0].kind, "reserveSync");

  console.log("session creation service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
