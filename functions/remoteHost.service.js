"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const {cleanName, httpError, serialize} = require("./backendUtils.helpers");
const {connectRemoteHost} = require("./remoteHost.connection");

const DEFAULT_SSH_PORT = 22;
const MAX_HOSTS_PER_OWNER = 1;
// Node's IP matcher also recognizes IPv4-mapped IPv6 encodings, including
// their hexadecimal form. Text-prefix checks miss those equivalent targets.
const DISALLOWED_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]]) {
  DISALLOWED_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) {
  DISALLOWED_ADDRESSES.addSubnet(address, prefix, "ipv6");
}
const HOST_STATUS = Object.freeze({
  PENDING_SETUP: "pending_setup",
  AWAITING_HOST_KEY: "awaiting_host_key",
  READY: "ready",
  UNREACHABLE: "unreachable",
  ERROR: "error",
  REVOKED: "revoked",
});
const ACTIVE_OPERATION_STATES = new Set([
  "provisioning", "starting", "running", "stopping", "deleting", "queued", "retrying", "unreachable", "error",
]);

function createRemoteHostService(dependencies = {}) {
  const service = {
    listRemoteHosts: (uid) => listRemoteHosts(uid, dependencies),
    getRemoteHost: (uid, hostId) => getRemoteHost(uid, hostId, dependencies),
    registerRemoteHost: (uid, payload) => registerRemoteHost(uid, payload, dependencies),
    updateRemoteHost: (uid, hostId, payload) => updateRemoteHost(uid, hostId, payload, dependencies),
    testRemoteHost: (uid, hostId) => testRemoteHost(uid, hostId, dependencies),
    removeRemoteHost: (uid, hostId) => removeRemoteHost(uid, hostId, dependencies),
  };
  return Object.freeze(service);
}

async function listRemoteHosts(uid, dependencies = {}) {
  const snapshot = await ownerHostQuery(uid, dependencies).get();
  return {
    hosts: (snapshot.docs || [])
        .filter((doc) => !doc.data()?.deletedAt)
        .map(serializeRemoteHost),
  };
}

async function getRemoteHost(uid, hostId, dependencies = {}) {
  const doc = await requireOwnedHost(uid, hostId, dependencies);
  return serializeRemoteHost(doc);
}

async function registerRemoteHost(uid, payload = {}, dependencies = {}) {
  const normalized = normalizeRemoteHostPayload(payload);
  const keyMaterial = generateKeyMaterial(dependencies);
  const hostId = createHostId(dependencies);
  const hostRef = hostCollection(dependencies).doc(hostId);
  const privateRef = privateHostRef(uid, hostId, dependencies);
  const now = timestamp(dependencies);
  const data = {
    ownerUid: uid,
    hostId,
    displayName: normalized.displayName,
    address: normalized.address,
    port: normalized.port,
    managedUsername: normalized.managedUsername,
    hostKeyFingerprint: normalized.hostKeyFingerprint || null,
    appPublicKey: keyMaterial.publicKey,
    appPublicKeyFingerprint: keyMaterial.publicKeyFingerprint,
    keyVersion: 1,
    setupVersion: 1,
    status: HOST_STATUS.PENDING_SETUP,
    ready: false,
    createdAt: now,
    updatedAt: now,
    ...(normalized.hostKeyFingerprint ? {status: HOST_STATUS.AWAITING_HOST_KEY} : {}),
  };

  await firestoreTransaction(dependencies, async (transaction) => {
    const existing = await transaction.get(ownerHostQuery(uid, dependencies));
    const active = (existing.docs || []).find((doc) => !doc.data()?.deletedAt);
    if (active) throw httpError(409, "remote_host_limit_reached");
    transaction.set(hostRef, data);
    transaction.set(privateRef, {
      ownerUid: uid,
      hostId,
      keyVersion: 1,
      privateKey: keyMaterial.privateKey,
      publicKey: keyMaterial.publicKey,
      createdAt: now,
      updatedAt: now,
    });
  });

  return serializeRemoteHost(await hostRef.get());
}

async function updateRemoteHost(uid, hostId, payload = {}, dependencies = {}) {
  const hostRef = hostCollection(dependencies).doc(normalizeHostId(hostId));
  const current = await requireOwnedHost(uid, hostId, dependencies);
  const currentData = current.data() || {};
  const next = normalizeRemoteHostPatch(payload, currentData);
  const now = timestamp(dependencies);
  const changedAddress = next.address !== currentData.address || next.port !== currentData.port ||
    next.managedUsername !== currentData.managedUsername;
  const patch = {
    ...next,
    updatedAt: now,
    ...(changedAddress ? {
      hostKeyFingerprint: null,
      status: HOST_STATUS.PENDING_SETUP,
      ready: false,
      lastConnectionError: null,
    } : {}),
  };
  await hostRef.set(patch, {merge: true});
  return serializeRemoteHost(await hostRef.get());
}

async function testRemoteHost(uid, hostId, dependencies = {}) {
  const doc = await requireOwnedHost(uid, hostId, dependencies);
  const host = doc.data() || {};
  const privateDoc = await privateHostRef(uid, hostId, dependencies).get();
  if (!privateDoc.exists || !privateDoc.data()?.privateKey) {
    throw httpError(409, "remote_host_key_revoked");
  }
  const addresses = await resolveAllowedAddresses(host.address, dependencies);
  let result;
  try {
    result = await connectToHost({
      host: {...host, id: doc.id},
      addresses,
      privateKey: privateDoc.data().privateKey,
      dependencies,
    });
  } catch (error) {
    await updateHostStatus(doc.ref, HOST_STATUS.UNREACHABLE, error.publicMessage || "remote_host_unreachable", dependencies);
    if (error.publicMessage) throw error;
    throw httpError(502, "remote_host_unreachable", error);
  }

  const observedFingerprint = normalizeFingerprint(result && result.hostKeyFingerprint, {required: true});
  if (host.hostKeyFingerprint && host.hostKeyFingerprint !== observedFingerprint) {
    await updateHostStatus(doc.ref, HOST_STATUS.ERROR, "remote_host_key_mismatch", dependencies);
    const error = httpError(502, "remote_host_key_mismatch");
    error.hostKeyFingerprint = observedFingerprint;
    throw error;
  }
  if (!host.hostKeyFingerprint) {
    await updateHostStatus(doc.ref, HOST_STATUS.AWAITING_HOST_KEY, null, dependencies);
    return {
      ready: false,
      requiresHostKeyConfirmation: true,
      observedHostKeyFingerprint: observedFingerprint,
      host: serializeRemoteHost(await doc.ref.get()),
    };
  }

  const safeCapacity = normalizeCapacity(result && result.capacity);
  await doc.ref.set({
    status: HOST_STATUS.READY,
    ready: true,
    lastConnectionAt: timestamp(dependencies),
    lastConnectionError: null,
    ...(safeCapacity ? {capacity: safeCapacity} : {}),
    updatedAt: timestamp(dependencies),
  }, {merge: true});
  return {
    ready: true,
    observedHostKeyFingerprint: observedFingerprint,
    host: serializeRemoteHost(await doc.ref.get()),
  };
}

async function removeRemoteHost(uid, hostId, dependencies = {}) {
  const normalizedId = normalizeHostId(hostId);
  const hostRef = hostCollection(dependencies).doc(normalizedId);
  const privateRef = privateHostRef(uid, normalizedId, dependencies);
  const now = timestamp(dependencies);
  let removedData;
  await firestoreTransaction(dependencies, async (transaction) => {
    const hostDoc = await transaction.get(hostRef);
    if (!hostDoc.exists || hostDoc.data()?.ownerUid !== uid) throw httpError(404, "remote_host_not_found");
    const host = hostDoc.data() || {};
    if (host.deletedAt) throw httpError(404, "remote_host_not_found");
    const [workspaceSnapshot, operationSnapshot] = await Promise.all([
      transaction.get(dependencies.db.collection("workspaces").where("ownerUid", "==", uid)),
      transaction.get(dependencies.db.collection("remoteVmOperations").where("ownerUid", "==", uid)),
    ]);
    const workspaceReferenced = (workspaceSnapshot.docs || []).some((doc) => {
      const data = doc.data() || {};
      return (data.hostId === normalizedId || data.runtimeProvider?.hostId === normalizedId) && !data.deletedAt;
    });
    const operationActive = (operationSnapshot.docs || []).some((doc) => {
      const data = doc.data() || {};
      return data.hostId === normalizedId && ACTIVE_OPERATION_STATES.has(String(data.state || "").toLowerCase());
    });
    if (workspaceReferenced || operationActive) throw httpError(409, "remote_host_referenced");
    removedData = {
      ...host,
      status: HOST_STATUS.REVOKED,
      ready: false,
      deletedAt: now,
      revokedAt: now,
      updatedAt: now,
      removalInstructions: "Remove the matching Mapache public key from the managed account's authorized_keys file on the host.",
    };
    transaction.set(hostRef, removedData, {merge: true});
    transaction.delete(privateRef);
  });
  return {
    ok: true,
    hostId: normalizedId,
    removalInstructions: removedData.removalInstructions,
  };
}

function normalizeRemoteHostPayload(payload = {}) {
  const displayName = cleanName(payload.displayName || payload.name || "").slice(0, 128);
  if (!displayName) throw httpError(400, "remote_host_display_name_required");
  const address = normalizeHostAddress(payload.address || payload.host);
  const port = normalizePort(payload.port);
  const managedUsername = normalizeManagedUsername(payload.managedUsername || payload.username);
  const hostKeyFingerprint = payload.hostKeyFingerprint == null || payload.hostKeyFingerprint === "" ?
    "" : normalizeFingerprint(payload.hostKeyFingerprint);
  if (hostKeyFingerprint && payload.confirmHostKey !== true) {
    throw httpError(400, "remote_host_key_confirmation_required");
  }
  return {displayName, address, port, managedUsername, hostKeyFingerprint};
}

function normalizeRemoteHostPatch(payload = {}, current = {}) {
  const next = {};
  if (Object.prototype.hasOwnProperty.call(payload, "displayName") || Object.prototype.hasOwnProperty.call(payload, "name")) {
    next.displayName = cleanName(payload.displayName || payload.name || "").slice(0, 128);
    if (!next.displayName) throw httpError(400, "remote_host_display_name_required");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "address") || Object.prototype.hasOwnProperty.call(payload, "host")) {
    next.address = normalizeHostAddress(payload.address || payload.host);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "port")) next.port = normalizePort(payload.port);
  if (Object.prototype.hasOwnProperty.call(payload, "managedUsername") || Object.prototype.hasOwnProperty.call(payload, "username")) {
    next.managedUsername = normalizeManagedUsername(payload.managedUsername || payload.username);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "hostKeyFingerprint")) {
    if (payload.confirmHostKey !== true) throw httpError(400, "remote_host_key_confirmation_required");
    next.hostKeyFingerprint = normalizeFingerprint(payload.hostKeyFingerprint);
    next.status = HOST_STATUS.AWAITING_HOST_KEY;
    next.ready = false;
  }
  if (!Object.keys(next).length) throw httpError(400, "remote_host_update_required");
  return {
    displayName: next.displayName || current.displayName,
    address: next.address || current.address,
    port: next.port || current.port,
    managedUsername: next.managedUsername || current.managedUsername,
    ...(next.hostKeyFingerprint ? {hostKeyFingerprint: next.hostKeyFingerprint} : {}),
    ...(next.status ? {status: next.status, ready: false} : {}),
  };
}

function normalizeHostAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  if (!address || address.length > 253 || /[\s/@#?%\\]/.test(address) || address.includes("..")) {
    throw httpError(400, "remote_host_address_invalid");
  }
  if (net.isIP(address) === 0 && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(address)) {
    throw httpError(400, "remote_host_address_invalid");
  }
  if (isDisallowedHostname(address) || isDisallowedIp(address)) {
    throw httpError(400, "remote_host_address_disallowed");
  }
  return address;
}

function normalizePort(value) {
  const port = value == null || value === "" ? DEFAULT_SSH_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, "remote_host_port_invalid");
  return port;
}

function normalizeManagedUsername(value) {
  const username = cleanName(value || "mapache").slice(0, 64);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) throw httpError(400, "remote_host_username_invalid");
  return username;
}

function normalizeHostId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw httpError(400, "remote_host_id_invalid");
  return id;
}

function normalizeFingerprint(value, {required = false} = {}) {
  const fingerprint = String(value || "").trim();
  if (!fingerprint && !required) return "";
  if (!/^(?:SHA256[/:][A-Za-z0-9+/=_-]{8,}|[0-9a-f]{2}(?::[0-9a-f]{2}){15,63})$/i.test(fingerprint)) {
    throw httpError(400, "remote_host_fingerprint_invalid");
  }
  return fingerprint;
}

function normalizeCapacity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["cpuCount", "memoryBytes", "freeDiskBytes"]) {
    if (value[key] == null) continue;
    const number = Number(value[key]);
    if (Number.isSafeInteger(number) && number >= 0) result[key] = number;
  }
  return Object.keys(result).length ? result : null;
}

async function resolveAllowedAddresses(address, dependencies = {}) {
  address = normalizeHostAddress(address);
  if (net.isIP(address)) return [address];
  if (isDisallowedHostname(address)) throw httpError(400, "remote_host_address_disallowed");
  const resolver = dependencies.resolveHost || ((host) => dns.lookup(host, {all: true, verbatim: true}));
  let records;
  try {
    records = await resolver(address);
  } catch (error) {
    throw httpError(502, "remote_host_dns_failed", error);
  }
  const addresses = (Array.isArray(records) ? records : [records])
      .map((record) => typeof record === "string" ? record : record && record.address)
      .filter(Boolean);
  if (!addresses.length || addresses.some((item) => !net.isIP(item) || isDisallowedIp(item))) {
    throw httpError(400, "remote_host_address_disallowed");
  }
  return [...new Set(addresses)];
}

function isDisallowedHostname(value) {
  const host = String(value || "").toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "metadata" || host === "metadata.google.internal";
}

function isDisallowedIp(value) {
  const address = String(value || "").toLowerCase();
  const version = net.isIP(address);
  return version !== 0 && DISALLOWED_ADDRESSES.check(address, version === 4 ? "ipv4" : "ipv6");
}

async function connectToHost({host, addresses, privateKey, dependencies}) {
  const connector = dependencies.hostConnector || dependencies.testConnection || connectRemoteHost;
  return connector({
    host: {
      id: host.id,
      address: host.address,
      port: host.port,
      managedUsername: host.managedUsername,
      hostKeyFingerprint: host.hostKeyFingerprint || null,
    },
    addresses,
    privateKey,
  });
}

function generateKeyMaterial(dependencies = {}) {
  if (typeof dependencies.generateKeyMaterial === "function") return dependencies.generateKeyMaterial();
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({type: "pkcs8", format: "pem"}).toString();
  const rawPublic = pair.publicKey.export({type: "spki", format: "der"}).subarray(-32);
  const type = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([uint32(type.length), type, uint32(rawPublic.length), rawPublic]);
  const publicKey = `ssh-ed25519 ${blob.toString("base64")} mapache-remote-host`;
  const publicKeyFingerprint = `SHA256/${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  return {privateKey, publicKey, publicKeyFingerprint};
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function serializeRemoteHost(doc) {
  const data = serialize(doc.data ? doc.data() : doc) || {};
  return {
    id: doc.id || data.hostId,
    hostId: data.hostId || doc.id,
    ownerUid: data.ownerUid,
    displayName: data.displayName,
    address: data.address,
    port: data.port,
    managedUsername: data.managedUsername,
    hostKeyFingerprint: data.hostKeyFingerprint || null,
    appPublicKey: data.appPublicKey || null,
    appPublicKeyFingerprint: data.appPublicKeyFingerprint || null,
    setupVersion: data.setupVersion || 1,
    keyVersion: data.keyVersion || 1,
    status: data.status || HOST_STATUS.PENDING_SETUP,
    ready: data.ready === true,
    capacity: data.capacity || null,
    lastConnectionAt: data.lastConnectionAt || null,
    lastConnectionError: data.lastConnectionError || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    setupDirections: [
      "Install the generated appPublicKey on the managed account's authorized_keys file.",
      "Download install.py, helper.py, and mapache_guest_config.py from the same Mapache release, inspect the files, then run: sudo python3 install.py --public-key ./mapache-remote-host.pub",
      "Verify the host fingerprint before testing the connection; remove the generated public key from authorized_keys when revoking access.",
    ],
  };
}

function hostCollection(dependencies = {}) {
  if (!dependencies.db) throw new Error("Remote host service requires a db dependency.");
  return dependencies.db.collection("remoteHosts");
}

function ownerHostQuery(uid, dependencies = {}) {
  return hostCollection(dependencies).where("ownerUid", "==", uid);
}

function privateHostRef(uid, hostId, dependencies = {}) {
  return dependencies.db.collection("users").doc(uid).collection("private")
      .doc("remoteHosts").collection("entries").doc(hostId);
}

async function requireOwnedHost(uid, hostId, dependencies = {}) {
  const normalizedId = normalizeHostId(hostId);
  const doc = await hostCollection(dependencies).doc(normalizedId).get();
  if (!doc.exists || doc.data()?.ownerUid !== uid || doc.data()?.deletedAt) {
    throw httpError(404, "remote_host_not_found");
  }
  return doc;
}

async function updateHostStatus(ref, status, errorCode, dependencies = {}) {
  await ref.set({
    status,
    ready: status === HOST_STATUS.READY,
    lastConnectionError: errorCode || null,
    updatedAt: timestamp(dependencies),
  }, {merge: true});
}

async function firestoreTransaction(dependencies, callback) {
  if (!dependencies.db || typeof dependencies.db.runTransaction !== "function") {
    throw new Error("Remote host service requires transactional Firestore.");
  }
  return dependencies.db.runTransaction(callback);
}

function createHostId(dependencies = {}) {
  const id = typeof dependencies.createHostId === "function" ? dependencies.createHostId() : crypto.randomUUID();
  return normalizeHostId(`host-${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96)}`);
}

function timestamp(dependencies = {}) {
  if (typeof dependencies.now === "function") return dependencies.now();
  if (dependencies.admin?.firestore?.FieldValue?.serverTimestamp) return dependencies.admin.firestore.FieldValue.serverTimestamp();
  return new Date().toISOString();
}

module.exports = {
  ACTIVE_OPERATION_STATES,
  DEFAULT_SSH_PORT,
  HOST_STATUS,
  createRemoteHostService,
  generateKeyMaterial,
  isDisallowedIp,
  normalizeFingerprint,
  normalizeHostAddress,
  normalizeRemoteHostPayload,
  resolveAllowedAddresses,
  serializeRemoteHost,
};
