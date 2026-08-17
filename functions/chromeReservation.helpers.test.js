"use strict";

const assert = require("assert");
const {
  findActiveChromeSession,
  isActiveChromeSession,
  isChromeSession,
} = require("./chromeReservation.helpers");

assert.strictEqual(isChromeSession({capabilities: {chrome: true}}), true);
assert.strictEqual(isChromeSession({capabilities: {chrome: false}}), false);
assert.strictEqual(isActiveChromeSession({capabilities: {chrome: true}, status: "running"}), true);
assert.strictEqual(isActiveChromeSession({capabilities: {chrome: true}, status: "stopped"}), false);
assert.strictEqual(isActiveChromeSession({capabilities: {chrome: true}, status: "provision_failed"}), false);

const active = {id: "active", capabilities: {chrome: true}, status: "running"};
assert.strictEqual(findActiveChromeSession([
  {id: "stopped", capabilities: {chrome: true}, status: "stopped"},
  active,
], "other"), active);
assert.strictEqual(findActiveChromeSession([active], "active"), null);
