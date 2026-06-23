"use strict";

const assert = require("assert");
const test = require("node:test");
const {createWorkspaceAuthService, mergeRemoteAuthData} = require("./workspaceAuth.service");

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
