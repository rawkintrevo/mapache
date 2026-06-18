"use strict";

const assert = require("assert");
const {
  mintQaCustomToken,
  requestSecret,
  secretsMatch,
} = require("./qaAuth.service");

function request(secret, body = {}) {
  return {
    body,
    get(name) {
      return name === "x-mapache-qa-secret" ? secret : "";
    },
  };
}

function createAuthStub(options = {}) {
  const calls = [];
  return {
    calls,
    async updateUser(uid, profile) {
      calls.push(["updateUser", uid, profile]);
      if (options.missingUser) {
        const error = new Error("missing");
        error.code = "auth/user-not-found";
        throw error;
      }
      return {};
    },
    async createUser(profile) {
      calls.push(["createUser", profile]);
      return {};
    },
    async createCustomToken(uid, claims) {
      calls.push(["createCustomToken", uid, claims]);
      return `token-for-${uid}`;
    },
  };
}

(async () => {
  assert.strictEqual(requestSecret(request("from-header", {secret: "from-body"})), "from-header");
  assert.strictEqual(requestSecret(request("", {secret: "from-body"})), "from-body");
  assert.strictEqual(secretsMatch("same", "same"), true);
  assert.strictEqual(secretsMatch("same", "nope"), false);
  assert.strictEqual(secretsMatch("", "nope"), false);

  await assert.rejects(
      () => mintQaCustomToken(request("secret"), createAuthStub(), {
        secret: "",
        uid: "qa-agent",
        email: "qa@example.com",
      }),
      /qa_login_not_configured/,
  );

  await assert.rejects(
      () => mintQaCustomToken(request("wrong"), createAuthStub(), {
        secret: "secret",
        uid: "qa-agent",
        email: "qa@example.com",
      }),
      /qa_login_denied/,
  );

  const auth = createAuthStub({missingUser: true});
  assert.deepStrictEqual(await mintQaCustomToken(request("secret"), auth, {
    secret: "secret",
    uid: "qa-agent",
    email: "qa@example.com",
    displayName: "QA Agent",
  }), {
    token: "token-for-qa-agent",
    uid: "qa-agent",
    email: "qa@example.com",
  });
  assert.deepStrictEqual(auth.calls.map((call) => call[0]), [
    "updateUser",
    "createUser",
    "createCustomToken",
  ]);

  console.log("qa auth service tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
