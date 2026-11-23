"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createVmRuntimeControlService, tokenHash, LEASE_MS} = require("./vmRuntimeControl.service");

function harness() {
  let time = 1000;
  const token = "a".repeat(64);
  const workspace = {ownerUid: "owner", backend: "compute-engine", currentSessionId: "session", generation: 1, state: "reserved"};
  const session = {ownerUid: "owner", generation: 1, state: "reserved", controlTokenHash: tokenHash(token)};
  const docs = new Map([["vmRuntimes_v2/workspace", workspace], ["vmRuntimes_v2/workspace/sessions/session", session]]);
  function ref(path) {
    return {path, collection: (id) => ref(`${path}/${id}`), doc: (id = "history") => ref(`${path}/${id}`)};
  }
  const service = createVmRuntimeControlService({
    now: () => time,
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIME"}}},
    db: {collection: ref, runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({
        get: async (r) => ({exists: docs.has(r.path), data: () => docs.get(r.path)}),
        update: (r, data) => writes.push(() => Object.assign(docs.get(r.path), data)),
        set: (r, data) => writes.push(() => docs.set(r.path, data)),
      });
      writes.forEach((write) => write());
      return result;
    }},
  });
  return {workspace, session, docs, advance: (ms) => { time += ms; }, call: (action, overrides = {}, presentedToken = token) => service({
    method: "POST", get: () => `Bearer ${presentedToken}`,
    body: {workspaceId: "workspace", sessionId: "session", generation: 1, bootId: "boot-a", action, ...overrides},
  })};
}

test("one boot is admitted; another boot and stale generation cannot take authority", async () => {
  const h = harness();
  await h.call("lease.acquire");
  await assert.rejects(h.call("lease.acquire", {bootId: "boot-b"}), /vm_boot_conflict/);
  await assert.rejects(h.call("lease.renew", {generation: 2}), /vm_generation_mismatch/);
  assert.equal(h.workspace.bootId, "boot-a");
  h.advance(10000);
  await h.call("lease.renew");
  assert.equal(h.session.leaseExpiresAt, 11000 + LEASE_MS);
});

test("missing, cross-session and wrong credentials cannot read or write", async () => {
  const h = harness();
  await assert.rejects(h.call("lease.acquire", {}, ""), /not_found/);
  await assert.rejects(h.call("lease.acquire", {}, "b".repeat(64)), /not_found/);
  await assert.rejects(h.call("lease.acquire", {sessionId: "foreign"}), /not_found/);
  await assert.rejects(h.call("lease.acquire", {workspaceId: "../foreign"}), /invalid_identity/);
  assert.equal(h.workspace.state, "reserved");
});

test("expired or released boots cannot renew, mutate state, or reclaim the disk", async () => {
  const h = harness();
  await h.call("lease.acquire");
  h.advance(LEASE_MS + 1);
  await assert.rejects(h.call("lease.renew"), /vm_writer_authority_lost/);
  await assert.rejects(h.call("lease.acquire"), /vm_boot_conflict/);
  const r = harness();
  await r.call("lease.acquire");
  await r.call("lease.release");
  await assert.rejects(r.call("models.set", {payload: {models: ["changed"]}}), /vm_session_unavailable/);
});

test("stop cannot be undone by an idempotent acquire retry", async () => {
  const h = harness();
  await h.call("lease.acquire");
  h.workspace.state = "stopping";
  await assert.rejects(h.call("lease.acquire"), /vm_boot_not_reserved/);
  await h.call("lease.renew");
  assert.equal(h.workspace.state, "stopping");
});

test("activity is constrained to telemetry and cannot alter admission or credentials", async () => {
  const h = harness();
  await h.call("lease.acquire");
  await h.call("activity", {payload: {lastActivityAt: true, activeSocketCount: 2}});
  assert.equal(h.session.lastActivityAt, "SERVER_TIME");
  await assert.rejects(h.call("activity", {payload: {state: "reserved"}}), /invalid_activity_field/);
  await assert.rejects(h.call("activity", {payload: {activeSocketCount: -1}}), /invalid_activity_field/);
  assert.equal(h.session.state, "active");
});

test("auth returns only centrally selected credentials and never an owner-wide dump", async () => {
  const h = harness();
  h.docs.set("users/owner/private/agentAuth", {entries: {
    chosen: {providerKey: "openai", credential: {type: "api_key", key: "selected-secret"}},
    other: {providerKey: "anthropic", credential: {type: "api_key", key: "unselected-secret"}},
  }});
  h.session.authSelection = {harness: "pi", providers: {openai: "chosen"}};
  await h.call("lease.acquire");
  const result = await h.call("auth.get");
  assert.equal(result.data.entries.chosen.credential.key, "selected-secret");
  assert.equal(result.data.entries.other, undefined);
  assert.deepEqual(result.data.providers, {});
  assert.ok(!JSON.stringify(result).includes("unselected-secret"));
});
