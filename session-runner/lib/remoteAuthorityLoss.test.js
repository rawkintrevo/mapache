"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createRemoteAuthorityLossHandler} = require("./remoteAuthorityLoss");

test("remote loss stops the agent before failing the runner, once across duplicate callbacks", async () => {
  const events = [];
  const lost = createRemoteAuthorityLossHandler({stop: async () => events.push("stopped"),
    exit: (code) => events.push(`exit:${code}`)});
  const first = lost();
  assert.equal(lost(), first);
  await first;
  assert.deepEqual(events, ["stopped", "exit:1"]);
  await lost();
  assert.equal(events.length, 2);
});

test("stop failure still exits and logs no raw error or credential data", async () => {
  const events = [];
  await createRemoteAuthorityLossHandler({stop: async () => { throw new Error("private-secret"); },
    logger: {error: (message) => events.push(message)}, exit: (code) => events.push(code)})();
  assert.deepEqual(events, ["remote agent stop failed after authority loss", 1]);
});

test("a hung stop cannot keep the guest runner alive", {timeout: 3000}, async () => {
  const child = spawn(process.execPath, ["-e", `
    require(${JSON.stringify(require.resolve("./remoteAuthorityLoss"))}).createRemoteAuthorityLossHandler({
      stop: () => new Promise(() => {}), timeoutMs: 50,
    })();
  `], {stdio: "ignore"});
  assert.deepEqual(await once(child, "exit"), [1, null]);
});
