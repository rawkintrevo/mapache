"use strict";
const {httpError} = require("./backendUtils.helpers");
const {normalizeEnvironmentEntryIds, normalizeGenericEnvironmentPayload} = require("./environmentKeys.service");

// Runtime authority and durable paths are never user environment selections.
// Keep this VM-only so deploying the crossover does not alter legacy functions.
function validateVmEnvironmentName(name) {
  if (/^(?:MAPACHE_|RUNTIME_|WORKSPACE_|SESSION_|GCLOUD_PROJECT$|GOOGLE_APPLICATION_CREDENTIALS$|XDG_)/.test(name)) {
    throw httpError(400, "reserved_vm_environment_name");
  }
}

async function resolveVmEnvironment({db, ownerUid, entryIds = [], read = ref => ref.get()}) {
  if (!Array.isArray(entryIds) || entryIds.length > 50) throw httpError(400, "invalid_vm_environment_entries");
  const ids = normalizeEnvironmentEntryIds(entryIds);
  const entries = await Promise.all(ids.map(id => read(db.collection("users").doc(ownerUid)
      .collection("private").doc("environmentKeys").collection("entries").doc(id))));
  const env = {};
  for (const snapshot of entries) {
    const data = snapshot.data();
    // Deleted and foreign references fail closed rather than launching a machine
    // with silently missing configuration. Never include values in error text.
    if (!data || data.ownerUid !== ownerUid) throw httpError(409, "vm_environment_entry_unavailable");
    const {name, value} = normalizeGenericEnvironmentPayload(data);
    if (!name) throw httpError(400, "invalid_environment_variable_name");
    validateVmEnvironmentName(name);
    if (Object.hasOwn(env, name)) throw httpError(409, "vm_environment_name_conflict");
    Object.defineProperty(env, name, {value, enumerable: true, configurable: true});
  }
  return env;
}

module.exports = {resolveVmEnvironment};
