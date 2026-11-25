"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {createVmFixtureAuthService} = require("./vmFixtureAuth.service");
test("fixture signer cannot mint arbitrary identities or replace an existing unrelated user", async () => {
  const ws = {ownerUid: "vm-proof-owner", apiEnabled: true, lifecycleEnabled: true};
  let user; const signed = []; const created = [];
  const service = createVmFixtureAuthService({db: {doc: () => ({get: async () => ({data: () => ws})})}, auth: {
    getUser: async () => { if (!user) throw {code: "auth/user-not-found"}; return user; },
    createUser: async profile => { created.push(profile.uid); }, setCustomUserClaims: async () => {},
    createCustomToken: async uid => { signed.push(uid); return "synthetic-token"; },
  }});
  const call = body => service({method: "POST", body});
  await assert.rejects(call({identity: "customer"}), /invalid_fixture_identity/);
  await assert.rejects(call({identity: "owner", uid: "customer"}), /invalid_fixture_identity/);
  assert.equal((await call({identity: "owner"})).uid, "vm-proof-owner");
  assert.deepEqual(signed, ["vm-proof-owner"]);
  assert.deepEqual(created, ["vm-proof-owner"]);
  user = {customClaims: {}};
  await assert.rejects(call({identity: "outsider"}), /fixture_user_conflict/);
  user = {customClaims: {vmFixture605: true}, disabled: true};
  await assert.rejects(call({identity: "outsider"}), /fixture_user_conflict/);
  ws.apiEnabled = false;
  await assert.rejects(call({identity: "owner"}), /fixture_not_admitted/);
});
