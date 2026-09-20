"use strict";

const assert = require("assert");
const {providerIdsFromToken, updateUserTimezone} = require("./auth.service");

assert.deepStrictEqual(providerIdsFromToken({}), []);
assert.deepStrictEqual(providerIdsFromToken({
  firebase: {
    identities: {
      "google.com": ["user@example.com"],
      email: ["user@example.com"],
    },
    sign_in_provider: "google.com",
  },
}), ["google.com"]);
assert.deepStrictEqual(providerIdsFromToken({
  firebase: {
    identities: {
      "github.com": ["uid"],
    },
    sign_in_provider: "password",
  },
}), ["password", "github.com"]);

(async () => {
  let profile = {uid: "user-1", email: "user@example.com"};
  const ref = {
    async get() { return {exists: true, id: "user-1", data: () => profile}; },
    async update(update) { profile = {...profile, ...update}; },
  };
  const updated = await updateUserTimezone("user-1", {timezone: "America/Chicago"}, {
    db: {collection: () => ({doc: () => ref})},
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}}},
  });
  assert.equal(updated.timezone, "America/Chicago");
  assert.equal(updated.updatedAt, "SERVER_TIMESTAMP");
  await assert.rejects(
      updateUserTimezone("user-1", {timezone: "Not/AZone"}, {
        db: {collection: () => ({doc: () => ref})},
        admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}}},
      }),
      (error) => error.publicMessage === "invalid_automation_timezone",
  );
  console.log("auth service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
