"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {shellCommand} = require("./shell");

test("shellCommand uses a login shell for local runner sessions", () => {
  const command = shellCommand({terminalKind: "shell"});
  assert.equal(command.file, process.env.SHELL || "bash");
  assert.deepEqual(command.args, ["-l"]);
});
