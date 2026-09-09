"use strict";

const assert = require("assert");
const {
  createEnvironmentKeysService,
  genericEnvironmentEntryId,
  normalizeGenericEnvironmentPayload,
} = require("./environmentKeys.service");

function publicMessage(error) {
  return error && error.publicMessage;
}

function createFakeDependencies() {
  const entriesByUid = new Map();
  let nextId = 1;
  const collectionFor = (uid) => {
    if (!entriesByUid.has(uid)) entriesByUid.set(uid, new Map());
    const entries = entriesByUid.get(uid);
    return {
      doc(id = `entry-${nextId++}`) {
        return {
          id,
          async delete() {
            entries.delete(id);
          },
          async get() {
            const data = entries.get(id);
            return {id, exists: Boolean(data), data: () => data};
          },
          async set(data, options = {}) {
            entries.set(id, options.merge ? {...(entries.get(id) || {}), ...data} : {...data});
          },
        };
      },
      async get() {
        return {
          docs: [...entries].map(([id, data]) => ({id, exists: true, data: () => data})),
        };
      },
    };
  };
  return {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}}},
    db: {
      collection(name) {
        assert.strictEqual(name, "users");
        return {
          doc(uid) {
            return {
              collection(name) {
                assert.strictEqual(name, "private");
                return {
                  doc(documentId) {
                    assert.strictEqual(documentId, "environmentKeys");
                    return {collection: (entryCollection) => {
                      assert.strictEqual(entryCollection, "entries");
                      return collectionFor(uid);
                    }};
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

assert.strictEqual(genericEnvironmentEntryId(" entry_1 "), "entry_1");
assert.throws(() => genericEnvironmentEntryId("bad/id"), (error) => publicMessage(error) === "invalid_environment_entry");
assert.deepStrictEqual(normalizeGenericEnvironmentPayload({name: " PROVIDER_TOKEN ", label: "Provider", value: "secret"}), {
  name: "PROVIDER_TOKEN",
  value: "secret",
  label: "Provider",
});
assert.throws(() => normalizeGenericEnvironmentPayload({name: "BAD-NAME", value: "secret"}),
    (error) => publicMessage(error) === "invalid_environment_variable_name");
assert.throws(() => normalizeGenericEnvironmentPayload({name: "SESSION_ID", value: "secret"}),
    (error) => publicMessage(error) === "reserved_environment_variable_name");
assert.throws(() => normalizeGenericEnvironmentPayload({name: "TOKEN", value: ""}),
    (error) => publicMessage(error) === "environment_value_required");

(async () => {
  const service = createEnvironmentKeysService(createFakeDependencies());
  const created = await service.createGenericEnvironmentKey("uid-1", {
    name: "Z_TOKEN",
    label: "Zed",
    value: "secret-value",
  });
  assert.strictEqual(created.name, "Z_TOKEN");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(created, "value"), false);

  const second = await service.createGenericEnvironmentKey("uid-1", {
    name: "A_TOKEN",
    label: "A",
    value: "another-secret",
  });
  const listed = await service.listGenericEnvironmentKeys("uid-1");
  assert.deepStrictEqual(listed.entries.map(({name, label}) => ({name, label})), [
    {name: "A_TOKEN", label: "A"},
    {name: "Z_TOKEN", label: "Zed"},
  ]);
  assert.strictEqual(JSON.stringify(listed).includes("secret"), false);

  const updated = await service.updateGenericEnvironmentKey("uid-1", created.id, {
    name: "UPDATED_TOKEN",
    label: "Updated",
    value: "new-secret",
  });
  assert.deepStrictEqual(updated, {
    id: created.id,
    name: "UPDATED_TOKEN",
    label: "Updated",
    updatedAt: "SERVER_TIMESTAMP",
  });
  assert.deepStrictEqual(await service.resolveGenericEnvironment("uid-1", [created.id, second.id, "missing"]), {
    UPDATED_TOKEN: "new-secret",
    A_TOKEN: "another-secret",
  });

  assert.deepStrictEqual(await service.deleteGenericEnvironmentKey("uid-1", second.id), {ok: true, id: second.id});
  assert.deepStrictEqual(await service.resolveGenericEnvironment("uid-1", [second.id]), {});
  await assert.rejects(
      service.resolveGenericEnvironment("uid-1", Array.from({length: 51}, (_, i) => `id-${i}`)),
      (error) => publicMessage(error) === "too_many_environment_entries",
  );
  console.log("environment keys service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
