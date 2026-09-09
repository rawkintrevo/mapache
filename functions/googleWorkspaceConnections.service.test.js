"use strict";

const assert = require("assert");
const {
  BINDING_FIELD,
  createGoogleWorkspaceConnectionsService,
} = require("./googleWorkspaceConnections.service");

function createFakeDependencies() {
  const users = new Map();
  const workspaces = new Map();
  function docFor(map, id, nested = null) {
    const ref = {
      id,
      async get() {
        const data = map.get(id);
        return {id, exists: Boolean(data), data: () => data};
      },
      async set(data, options = {}) {
        map.set(id, options.merge ? {...(map.get(id) || {}), ...data} : {...data});
      },
      async update(data) {
        map.set(id, {...(map.get(id) || {}), ...data});
      },
      async delete() {
        map.delete(id);
      },
    };
    ref.ref = ref;
    return ref;
  }
  function connectionCollection(uid) {
    if (!users.has(uid)) users.set(uid, new Map());
    const map = users.get(uid);
    return {
      doc(id) { return docFor(map, id); },
      async get() {
        return {docs: [...map].map(([id, data]) => ({id, data: () => data}))};
      },
    };
  }
  const db = {
    collection(name) {
      if (name === "users") return {doc(uid) {
        return {collection(privateName) {
          assert.strictEqual(privateName, "private");
          return {doc(collectionName) {
            assert.strictEqual(collectionName, "googleConnections");
            return {collection: () => connectionCollection(uid)};
          }};
        }};
      }};
      if (name === "workspaces") return {
        doc(id) { return docFor(workspaces, id); },
        where(field, operator, value) {
          assert.deepStrictEqual([field, operator], ["ownerUid", "=="]);
          return {async get() {
            return {docs: [...workspaces].filter(([, data]) => data.ownerUid === value)
                .map(([id, data]) => ({id, ref: docFor(workspaces, id), data: () => data}))};
          }};
        },
      };
      throw new Error(`unexpected collection ${name}`);
    },
  };
  return {db, now: () => "2026-08-19T00:00:00.000Z", users, workspaces};
}

function metadata(connectionId, email, services = ["gmail"]) {
  return {
    connectionId,
    googleSubject: `subject-${connectionId}`,
    email,
    displayName: email.split("@")[0],
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    enabledServices: services,
    oauthClientRef: "client-ref",
  };
}

(async () => {
  const dependencies = createFakeDependencies();
  const service = createGoogleWorkspaceConnectionsService(dependencies);
  dependencies.workspaces.set("workspace-a", {ownerUid: "user-a", name: "A"});
  dependencies.workspaces.set("workspace-b", {ownerUid: "user-a", name: "B"});
  dependencies.workspaces.set("workspace-other", {ownerUid: "user-b", name: "Other"});

  const accountA = await service.createGoogleConnection("user-a", metadata("connection-a", "a@example.com"), {
    ciphertext: "fake-a",
  });
  const accountB = await service.createGoogleConnection("user-a", metadata("connection-b", "b@example.com"), {
    ciphertext: "fake-b",
  });
  assert.strictEqual(JSON.stringify(accountA).includes("fake-a"), false);
  assert.deepStrictEqual((await service.listGoogleConnections("user-a")).connections.map((item) => item.email), [
    "a@example.com", "b@example.com",
  ]);
  assert.deepStrictEqual(await service.getGoogleConnection("user-a", "connection-a", {includePrivate: true}), {
    metadata: {...accountA, googleSubject: "subject-connection-a", grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"], oauthClientRef: "client-ref"},
    encryptedCredentials: {ciphertext: "fake-a"},
  });
  await assert.rejects(service.getGoogleConnection("user-b", "connection-a"), (error) => error.publicMessage === "google_connection_not_found");

  assert.deepStrictEqual(await service.bindGoogleWorkspaceConnection("user-a", "workspace-a", {
    connectionId: "connection-a", enabledServices: ["gmail"],
  }), {connectionId: "connection-a", enabledServices: ["gmail"]});
  await service.bindGoogleWorkspaceConnection("user-a", "workspace-b", {
    connectionId: "connection-b", enabledServices: ["gmail"],
  });
  assert.deepStrictEqual(await service.getGoogleWorkspaceBinding("user-a", "workspace-a"), {
    connectionId: "connection-a", enabledServices: ["gmail"],
  });
  assert.deepStrictEqual(await service.getGoogleWorkspaceBinding("user-a", "workspace-b"), {
    connectionId: "connection-b", enabledServices: ["gmail"],
  });
  await assert.rejects(service.bindGoogleWorkspaceConnection("user-b", "workspace-a", {
    connectionId: "connection-a", enabledServices: ["gmail"],
  }), (error) => error.publicMessage === "workspace_forbidden");

  await service.deleteGoogleConnection("user-a", "connection-a");
  assert.strictEqual(dependencies.workspaces.get("workspace-a")[BINDING_FIELD], null);
  assert.deepStrictEqual(dependencies.workspaces.get("workspace-b")[BINDING_FIELD], {
    connectionId: "connection-b", enabledServices: ["gmail"],
  });
  await service.unbindGoogleWorkspaceConnection("user-a", "workspace-b");
  assert.strictEqual(dependencies.workspaces.get("workspace-b")[BINDING_FIELD], null);
  console.log("google workspace connection service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
