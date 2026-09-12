"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {formatPrompt, renderTerminalPage, socketActivityUpdate} = require("./terminal");

test("formats prompts as one bracketed paste followed by carriage return", () => {
  assert.equal(formatPrompt("one\ntwo"), "\x1b[200~one\ntwo\x1b[201~\r");
});

test("socket bookkeeping does not count reconnects as terminal activity", () => {
  const timestamp = {seconds: 123};
  assert.deepEqual(socketActivityUpdate(1, "lastConnectedAt", timestamp), {
    activeSocketCount: 1,
    lastConnectedAt: timestamp,
  });
  assert.deepEqual(socketActivityUpdate(0, "lastDisconnectedAt", timestamp), {
    activeSocketCount: 0,
    lastDisconnectedAt: timestamp,
  });
});

test("renderTerminalPage includes critical xterm layout and helper-textarea styles", () => {
  const html = renderTerminalPage({accessToken: "token-123"});

  assert.match(html, /#terminal \.xterm-helper-textarea/);
  assert.doesNotMatch(html, /left: -9999em/);
  assert.doesNotMatch(html, /font-size: 0/);
  assert.match(html, /color: transparent/);
  assert.match(html, /caret-color: transparent/);
  assert.match(html, /#terminal \.xterm-viewport/);
  assert.match(html, /#terminal \.xterm-screen,\s*#terminal \.xterm-screen canvas/);
  assert.doesNotMatch(html, /helperTextarea\.value = ""/);
  assert.doesNotMatch(html, /helperTextarea\.addEventListener\("input"/);
  assert.match(html, /term\.onRender\(\(\) => \{\s*applyHelperTextareaStyles\(\);/);
  assert.match(html, /mapache_access/);
});

test("renderTerminalPage can target the independent shell WebSocket", () => {
  const html = renderTerminalPage({accessToken: "token-123", socketPath: "/shell"});
  assert.ok(html.includes('location.host + "/shell"'));
});
