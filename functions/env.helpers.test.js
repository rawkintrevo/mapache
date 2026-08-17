"use strict";

const assert = require("assert");
const {normalizeEnvMap, RESERVED_ENV_NAMES} = require("./env.helpers");

[
  "CHROME_PROFILE_DIR",
  "CHROME_CDP_PORT",
  "MAPACHE_BROWSER_CDP_URL",
  "MAPACHE_BROWSER_STATUS_URL",
  "MAPACHE_BROWSER_ACTIVITY_URL",
].forEach((name) => {
  assert.strictEqual(RESERVED_ENV_NAMES.has(name), true);
  assert.throws(() => normalizeEnvMap({[name]: "user-controlled"}), /reserved/);
});

assert.deepStrictEqual(normalizeEnvMap({BROWSER_THEME: "dark"}), {BROWSER_THEME: "dark"});
console.log("environment helper tests passed");
