"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  authFileProviders,
  buildGitHubCliHostsYaml,
  createWorkspaceAuthService,
  githubCliHostsPath,
  mergeRemoteAuthData,
  normalizeGitHubCliCredential,
  secretFileInventory,
} = require("./workspaceAuth.service");

test("mergeRemoteAuthData normalizes canonical agent auth", () => {
  assert.deepStrictEqual(mergeRemoteAuthData({
    providers: {openai: {type: "api_key", key: "new"}},
    entries: {
      "entry-new": {
        id: "entry-new",
        providerKey: "openai",
        label: "new",
        credential: {type: "api_key", key: "new"},
        createdAt: "2026-06-23T00:00:00.000Z",
      },
    },
  }), {
    providers: {openai: {type: "api_key", key: "new"}},
    entries: {
      "entry-new": {
        id: "entry-new",
        providerKey: "openai",
        label: "new",
        credential: {type: "api_key", key: "new"},
        createdAt: "2026-06-23T00:00:00.000Z",
      },
    },
  });
});

test("readSessionAuthSelection reads canonical authSelection", async () => {
  const service = createWorkspaceAuthService({
    admin: {
      firestore: {
        FieldValue: {
          serverTimestamp: () => "server-timestamp",
        },
      },
    },
    config: {
      ownerUid: "user-1",
      harnessId: "pi",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      workspaceDir: "/workspace",
      piAgentDir: "/root/.pi/agent",
    },
    db: {
      collection(name) {
        assert.strictEqual(name, "workspaces");
        return {
          doc(workspaceId) {
            assert.strictEqual(workspaceId, "workspace-1");
            return {
              collection(childName) {
                assert.strictEqual(childName, "sessions");
                return {
                  doc(sessionId) {
                    assert.strictEqual(sessionId, "session-1");
                    return {
                      get: async () => ({
                        exists: true,
                        data: () => ({
                          authSelection: {harness: "pi", providers: {openai: "entry-1"}},
                        }),
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
  });

  const selection = await service.readSessionAuthSelection();
  assert.deepStrictEqual(selection, {
    harness: "pi",
    providers: {openai: "entry-1"},
  });
});

test("readSessionAuthSelection ignores removed legacy piAuthSelection", async () => {
  const service = createWorkspaceAuthService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-timestamp"}}},
    config: {ownerUid: "user-1", harnessId: "pi", workspaceId: "workspace-1", sessionId: "session-1", workspaceDir: "/workspace", piAgentDir: "/root/.pi/agent"},
    db: {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({get: async () => ({exists: true, data: () => ({piAuthSelection: {openai: "entry-1"}})})}),
          }),
        }),
      }),
    },
  });

  assert.strictEqual(await service.readSessionAuthSelection(), null);
});

test("github cli api key credentials materialize as gh hosts.yml", () => {
  assert.deepStrictEqual(normalizeGitHubCliCredential({
    type: "api_key",
    key: " ghp_test ",
  }), {
    host: "github.com",
    oauthToken: "ghp_test",
    user: "",
    gitProtocol: "https",
  });
  assert.equal(buildGitHubCliHostsYaml({
    host: "github.com",
    oauthToken: "ghp_test",
    gitProtocol: "https",
    user: "octocat",
  }), [
    "github.com:",
    "    oauth_token: \"ghp_test\"",
    "    git_protocol: \"https\"",
    "    user: \"octocat\"",
  ].join("\n"));
  assert.equal(githubCliHostsPath({homeDir: "/root"}), "/root/.config/gh/hosts.yml");
});

test("github cli credentials are not written into native agent auth files", () => {
  assert.deepStrictEqual(authFileProviders({
    openai: {type: "api_key", key: "sk-test"},
    "github-cli": {type: "api_key", key: "ghp_test"},
  }), {
    openai: {type: "api_key", key: "sk-test"},
  });
});

test("managed Pi materialization ignores restored auth and replaces the fixed agent file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-managed-auth-"));
  const piAgentDir = path.join(root, "state", "pi");
  const legacyAgentDir = path.join(root, "home", ".pi", "agent");
  fs.mkdirSync(piAgentDir, {recursive: true});
  fs.mkdirSync(legacyAgentDir, {recursive: true});
  fs.writeFileSync(path.join(piAgentDir, "auth.json"), JSON.stringify({openai: {type: "api_key", key: "restored-secret"}}));
  fs.writeFileSync(path.join(piAgentDir, "provider-keys.json"), JSON.stringify({openai: {keys: [{name: "old", apiKey: "old-secret"}]}}));
  fs.writeFileSync(path.join(legacyAgentDir, "auth.json"), JSON.stringify({openai: {type: "api_key", key: "legacy-secret"}}));

  let remoteWrites = 0;
  const remoteData = {
    providers: {openai: {type: "api_key", key: "canonical-secret"}},
    entries: {
      "entry-openai": {
        id: "entry-openai",
        providerKey: "openai",
        credential: {type: "api_key", key: "canonical-secret"},
      },
    },
  };
  const service = createWorkspaceAuthService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-timestamp"}}},
    config: {
      agentRuntimeEnabled: true,
      agentStateRoot: path.join(root, "state"),
      harnessId: "pi",
      homeDir: path.join(root, "home"),
      ownerUid: "user-1",
      piAgentDir,
      workspaceDir: path.join(root, "workspace"),
    },
    db: {
      collection(name) {
        if (name === "users") {
          return {doc: () => ({collection: () => ({doc: () => ({
            get: async () => ({exists: true, data: () => remoteData}),
            set: async () => { remoteWrites += 1; },
          })})})};
        }
        if (name === "workspaces") {
          return {doc: () => ({collection: () => ({doc: () => ({
            get: async () => ({exists: false, data: () => ({})}),
          })})})};
        }
        throw new Error(`unexpected collection ${name}`);
      },
    },
  });

  try {
    const result = await service.synchronizeAuth({materialize: true});
    const written = JSON.parse(await fs.promises.readFile(path.join(piAgentDir, "auth.json"), "utf8"));
    assert.equal(written.openai.key, "canonical-secret");
    assert.equal(remoteWrites, 0);
    assert.equal(fs.existsSync(path.join(piAgentDir, "provider-keys.json")), false);
    assert.equal(JSON.stringify(result).includes("canonical-secret"), false);
    assert.deepStrictEqual(result.secretFiles.map((entry) => entry.id), [
      "agent-auth",
      "pi-provider-keys",
      "pi-model-config",
      "pi-mcp-oauth",
      "github-cli-hosts",
      "legacy-pi-auth",
    ]);
    assert.equal(fs.existsSync(path.join(legacyAgentDir, "auth.json")), true);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("private automation materialization resolves canonical credentials instead of restoring local secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-private-auth-"));
  const piAgentDir = path.join(root, "agent");
  fs.mkdirSync(piAgentDir, {recursive: true});
  fs.writeFileSync(path.join(piAgentDir, "auth.json"), JSON.stringify({openai: {type: "api_key", key: "stale-secret"}}));
  let remoteWrites = 0;
  const service = createWorkspaceAuthService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-timestamp"}}},
    config: {
      isPrivateRuntime: true,
      harnessId: "pi",
      homeDir: path.join(root, "home"),
      ownerUid: "user-1",
      piAgentDir,
      piMcpConfigPath: path.join(piAgentDir, "mcp.json"),
      workspaceDir: path.join(root, "workspace"),
    },
    db: {
      collection(name) {
        if (name === "users") {
          return {doc: () => ({collection: () => ({doc: () => ({
            get: async () => ({exists: true, data: () => ({providers: {openai: {type: "api_key", key: "fresh-secret"}}})}),
            set: async () => { remoteWrites += 1; },
          })})})};
        }
        if (name === "workspaces") {
          return {doc: () => ({collection: () => ({doc: () => ({
            get: async () => ({exists: false, data: () => ({})}),
          })})})};
        }
        throw new Error(`unexpected collection ${name}`);
      },
    },
  });

  try {
    await service.synchronizeAuth({materialize: true});
    const written = JSON.parse(await fs.promises.readFile(path.join(piAgentDir, "auth.json"), "utf8"));
    assert.equal(written.openai.key, "fresh-secret");
    assert.equal(remoteWrites, 0);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("secretFileInventory exposes classifications without credential values", () => {
  const inventory = secretFileInventory({
    agentRuntimeEnabled: true,
    harnessId: "pi",
    homeDir: "/root",
    piAgentDir: "/var/lib/mapache/agent/pi",
  });
  assert.equal(inventory.some((entry) => entry.id === "agent-auth" && entry.capture === "exclude"), true);
  assert.equal(inventory.some((entry) => entry.id === "pi-model-config" && entry.kind === "secret-bearing-config"), true);
  assert.equal(JSON.stringify(inventory).includes("canonical-secret"), false);
});
