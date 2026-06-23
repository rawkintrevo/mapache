"use strict";

const assert = require("assert");
const test = require("node:test");
const {buildCodexAuthFile, createWorkspaceAuthService, mergeRemoteAuthData} = require("./workspaceAuth.service");

test("mergeRemoteAuthData preserves legacy auth while preferring agentAuth providers", () => {
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
  }, {
    providers: {
      openai: {type: "api_key", key: "old"},
      anthropic: {type: "api_key", key: "legacy"},
    },
    entries: {
      "entry-old": {
        id: "entry-old",
        providerKey: "openai",
        label: "old",
        credential: {type: "api_key", key: "old"},
        createdAt: "2026-06-22T00:00:00.000Z",
      },
    },
  }), {
    providers: {
      openai: {type: "api_key", key: "new"},
      anthropic: {type: "api_key", key: "legacy"},
    },
    entries: {
      "entry-old": {
        id: "entry-old",
        providerKey: "openai",
        label: "old",
        credential: {type: "api_key", key: "old"},
        createdAt: "2026-06-22T00:00:00.000Z",
      },
      "entry-new": {
        id: "entry-new",
        providerKey: "openai",
        label: "new",
        credential: {type: "api_key", key: "new"},
        createdAt: "2026-06-23T00:00:00.000Z",
      },
      "legacy-anthropic": {
        id: "legacy-anthropic",
        providerKey: "anthropic",
        label: "anthropic",
        credential: {type: "api_key", key: "legacy"},
        createdAt: "",
      },
    },
  });
});

test("readSessionAuthSelection falls back to legacy piAuthSelection", async () => {
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
                          piAuthSelection: {openai: "entry-1"},
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

test("buildCodexAuthFile matches current Codex api key auth mode", () => {
  assert.deepStrictEqual(buildCodexAuthFile({
    openai: {type: "api_key", key: "sk-test"},
  }), {
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-test",
  });
});

test("buildCodexAuthFile drops malformed Codex oauth credentials", () => {
  assert.strictEqual(buildCodexAuthFile({
    "openai-codex": {
      type: "oauth",
      id: "",
      access: "access-token",
      refresh: "refresh-token",
      accountId: "acct_123",
    },
  }), null);
});

test("buildCodexAuthFile preserves valid Codex oauth credentials", () => {
  const auth = buildCodexAuthFile({
    "openai-codex": {
      type: "oauth",
      id: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
      access: "access-token",
      refresh: "refresh-token",
      accountId: "acct_123",
      expires: 1760000000000,
    },
  });
  assert.equal(auth.auth_mode, "chatgpt");
  assert.equal(auth.tokens.id_token, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature");
  assert.equal(auth.tokens.account_id, "acct_123");
  assert.equal(auth.last_refresh, "2025-10-09T08:53:20.000Z");
});
