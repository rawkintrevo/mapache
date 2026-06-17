"use strict";

const assert = require("assert");
const {providerIdsFromToken} = require("./auth.service");

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

console.log("auth service tests passed");
