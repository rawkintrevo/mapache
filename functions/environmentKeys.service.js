"use strict";

const {cleanName, httpError} = require("./backendUtils.helpers");
const {normalizeEnvMap} = require("./env.helpers");

function createEnvironmentKeysService(dependencies = {}) {
  return {
    listGenericEnvironmentKeys: (uid) => listGenericEnvironmentKeys(uid, dependencies),
    createGenericEnvironmentKey: (uid, payload) => createGenericEnvironmentKey(uid, payload, dependencies),
    updateGenericEnvironmentKey: (uid, entryId, payload) =>
      updateGenericEnvironmentKey(uid, entryId, payload, dependencies),
    deleteGenericEnvironmentKey: (uid, entryId) => deleteGenericEnvironmentKey(uid, entryId, dependencies),
    resolveGenericEnvironment: (uid, ids) => resolveGenericEnvironment(uid, ids, dependencies),
  };
}

function environmentKeysCollection(uid, dependencies = {}) {
  if (!dependencies.db) throw new Error("Environment keys service requires a db dependency.");
  return dependencies.db.collection("users").doc(uid).collection("private")
      .doc("environmentKeys").collection("entries");
}

function genericEnvironmentEntryId(value) {
  const id = cleanName(value);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw httpError(400, "invalid_environment_entry");
  }
  return id;
}

function normalizeEnvironmentEntryIds(ids = []) {
  return Array.isArray(ids) ? [...new Set(ids.map(genericEnvironmentEntryId))] : [];
}

function normalizeGenericEnvironmentPayload(payload = {}, requireValue = true) {
  const name = String(payload.name || "").trim();
  const env = normalizeEnvMap({[name]: requireValue ? payload.value : "x"}, {
    errorCode: "invalid_environment_key",
    invalidNameErrorCode: "invalid_environment_variable_name",
    reservedNameErrorCode: "reserved_environment_variable_name",
  });
  const value = requireValue ? String(payload.value == null ? "" : payload.value) : undefined;
  if (requireValue && !value) throw httpError(400, "environment_value_required");
  const label = cleanName(payload.label || "").slice(0, 128);
  return {name: Object.keys(env)[0], value, label};
}

function redactGenericEnvironmentEntry(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    name: data.name || "",
    label: data.label || "",
    updatedAt: data.updatedAt || null,
  };
}

async function listGenericEnvironmentKeys(uid, dependencies = {}) {
  const snap = await environmentKeysCollection(uid, dependencies).get();
  return {
    entries: snap.docs.map(redactGenericEnvironmentEntry)
        .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function createGenericEnvironmentKey(uid, payload, dependencies = {}) {
  const normalized = normalizeGenericEnvironmentPayload(payload);
  const ref = environmentKeysCollection(uid, dependencies).doc();
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await ref.set({ownerUid: uid, ...normalized, createdAt: now, updatedAt: now});
  return redactGenericEnvironmentEntry(await ref.get());
}

async function updateGenericEnvironmentKey(uid, entryId, payload, dependencies = {}) {
  const ref = environmentKeysCollection(uid, dependencies).doc(genericEnvironmentEntryId(entryId));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "environment_entry_not_found");
  const normalized = normalizeGenericEnvironmentPayload(payload);
  await ref.set({...normalized, updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
  return redactGenericEnvironmentEntry(await ref.get());
}

async function deleteGenericEnvironmentKey(uid, entryId, dependencies = {}) {
  const ref = environmentKeysCollection(uid, dependencies).doc(genericEnvironmentEntryId(entryId));
  await ref.delete();
  return {ok: true, id: ref.id};
}

async function resolveGenericEnvironment(uid, ids = [], dependencies = {}) {
  const requested = normalizeEnvironmentEntryIds(ids);
  if (requested.length > 50) throw httpError(400, "too_many_environment_entries");
  const docs = await Promise.all(requested.map((id) =>
    environmentKeysCollection(uid, dependencies).doc(id).get(),
  ));
  return docs.filter((doc) => doc.exists).reduce((acc, doc) => {
    const data = doc.data() || {};
    acc[data.name] = String(data.value || "");
    return acc;
  }, {});
}

module.exports = {
  createEnvironmentKeysService,
  genericEnvironmentEntryId,
  normalizeEnvironmentEntryIds,
  normalizeGenericEnvironmentPayload,
  redactGenericEnvironmentEntry,
  resolveGenericEnvironment,
};
