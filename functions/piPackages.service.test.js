"use strict";

const assert = require("assert");
const {
  buildGitPackageSource,
  createPiPackagesService,
  normalizeGitPackageSource,
  normalizePiPackageSource,
  parseGitPackageSource,
  piPackageCatalogDocId,
  piPackageCatalogRecord,
} = require("./piPackages.service");

function publicMessage(error) {
  return error && error.publicMessage;
}

assert.deepStrictEqual(normalizePiPackageSource("npm:@scope/pkg@1.2.3"), {
  source: "npm:@scope/pkg@1.2.3",
  type: "npm",
  identity: "npm:@scope/pkg",
  name: "@scope/pkg",
  pinned: true,
});
assert.deepStrictEqual(normalizePiPackageSource("github:owner/repo#main"), {
  source: "github:owner/repo#main",
  type: "git",
  identity: "git:github.com/owner/repo",
  host: "github.com",
  path: "owner/repo",
  pinned: true,
});
assert.deepStrictEqual(normalizeGitPackageSource("git+ssh://github.com/Owner/Repo.git#v1"), {
  source: "git+ssh://github.com/Owner/Repo.git#v1",
  type: "git",
  identity: "git:github.com/Owner/Repo",
  host: "github.com",
  path: "Owner/Repo",
  pinned: true,
});
assert.deepStrictEqual(parseGitPackageSource("git@github.com:owner/repo.git#main"), {
  host: "github.com",
  path: "owner/repo",
  ref: "main",
});
assert.deepStrictEqual(buildGitPackageSource("GitHub.COM", "/owner/repo.git"), {
  host: "github.com",
  path: "owner/repo",
  ref: "",
});
assert.throws(() => normalizePiPackageSource("npm:not valid"), (error) => publicMessage(error) === "invalid_package_source");
assert.throws(() => normalizePiPackageSource("https://user:pass@example.com/repo"), (error) => publicMessage(error) === "package_source_must_not_include_credentials");
assert.throws(() => normalizePiPackageSource("ftp://example.com/repo"), (error) => publicMessage(error) === "unsupported_package_source");
assert.strictEqual(piPackageCatalogDocId("git:github.com/owner/repo"), "git%3Agithub.com%2Fowner%2Frepo");

const fieldValue = {
  increment: (value) => ({increment: value}),
  serverTimestamp: () => "SERVER_TIMESTAMP",
};
assert.deepStrictEqual(piPackageCatalogRecord("npm:@scope/pkg@1.2.3", "workspace-1", {
  includeCreatedAt: true,
  incrementInstallCount: true,
}, {admin: {firestore: {FieldValue: fieldValue}}}), {
  identity: "npm:@scope/pkg",
  type: "npm",
  source: "npm:@scope/pkg@1.2.3",
  updatedAt: "SERVER_TIMESTAMP",
  lastWorkspaceId: "workspace-1",
  installCount: {increment: 1},
  createdAt: "SERVER_TIMESTAMP",
  favorite: false,
});

const runningSessionSnap = {
  data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "pi"}),
};
const stoppedSessionSnap = {
  data: () => ({serviceUrl: "", shutdownToken: "token", terminalKind: "pi"}),
};

function createPackageDb() {
  return {
    collection: () => ({doc: () => ({collection: () => ({
      get: async () => ({docs: []}),
      doc: () => ({get: async () => ({exists: false}), set: async () => {}}),
    })})}),
    runTransaction: async (callback) => callback({
      get: async () => ({exists: false}),
      set: () => {},
    }),
  };
}

(async () => {
  const calls = [];
  const service = createPiPackagesService({
    admin: {firestore: {FieldValue: fieldValue}},
    db: createPackageDb(),
    requireWorkspace: async () => ({}),
    requireSession: async (uid, workspaceId, sessionId) => ({
      sessionSnap: sessionId === "stopped" ? stoppedSessionSnap : runningSessionSnap,
    }),
    requestRunnerJson: async (session, routePath, options = {}) => {
      calls.push({session, routePath, options});
      return {ok: true, packages: [{source: "npm:@scope/pkg@1.2.3"}]};
    },
  });

  await assert.rejects(
      service.listPiPackages("uid", "workspace", "stopped"),
      (error) => error.status === 409 && publicMessage(error) === "no_active_session",
  );
  const listed = await service.listPiPackages("uid", "workspace", "session");
  assert.deepStrictEqual(listed.knownPackages, []);
  assert.strictEqual(calls[0].routePath, "/pi/packages");

  await service.installPiPackage("uid", "workspace", "session", {source: "npm:@scope/pkg@1.2.3"});
  assert.strictEqual(calls[1].routePath, "/pi/packages/install");
  assert.deepStrictEqual(calls[1].options.body, {source: "npm:@scope/pkg@1.2.3"});
  await service.removePiPackage("uid", "workspace", "session", {source: "github:owner/repo#main"});
  assert.strictEqual(calls[2].routePath, "/pi/packages/remove");
  await service.updatePiPackage("uid", "workspace", "session", {source: "npm:@scope/pkg"});
  assert.strictEqual(calls[3].routePath, "/pi/packages/update");

  console.log("Pi packages service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
