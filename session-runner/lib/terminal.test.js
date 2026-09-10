"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createTerminalSession, formatPrompt, renderTerminalPage, socketActivityUpdate} = require("./terminal");
const {createControlManager} = require("./controlManager");

test("formats Chat prompts as one bracketed paste followed by carriage return", () => {
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

test("pi-chrome terminal page carries a per-tab control binding", () => {
  const html = renderTerminalPage({accessToken: "token-123", webFirstEnabled: true});
  assert.match(html, /control_hello/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /control_heartbeat/);
});

test("pi-chrome terminal input is gated at the receiving boundary", () => {
  let onData;
  let onExit;
  const writes = [];
  const resizes = [];
  const messages = [];
  const term = {
    onData(listener) { onData = listener; },
    onExit(listener) { onExit = listener; return {dispose() { onExit = null; }}; },
    write(value) { writes.push(value); },
    resize(cols, rows) { resizes.push([cols, rows]); },
    kill() {},
  };
  const manager = createControlManager({runtimeId: "runtime-1", executionEpoch: 1, randomBytes: () => Buffer.alloc(32, "b")});
  const session = createTerminalSession({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    activity: {appendHistory() {}, updateSessionActivity() {}, updatePiSessionBinding() {}},
    config: {harnessId: "pi", terminalKind: "pi", workspaceDir: "/workspace", port: 8080, previewBasePath: "/preview", terminalReplayLimit: 1000, activityWriteDebounceMs: 1000, piSessionDir: ""},
    controlManager: manager,
    webFirstEnabled: true,
    spawnProcess: () => term,
  });
  const first = {readyState: 1, send(value) { messages.push(JSON.parse(value)); }, close() {}};
  const second = {readyState: 1, send(value) { messages.push(JSON.parse(value)); }, close() {}};
  session.attach(first, false);
  session.handleMessage(JSON.stringify({type: "control_hello", clientId: "tab-1"}), first);
  const hello = messages.at(-1);
  assert.equal(hello.type, "control_status");
  session.handleMessage(JSON.stringify({type: "data", data: "ls\r"}), first);
  assert.equal(writes.at(-1), "ls\r");
  session.attach(second, false);
  session.handleMessage(JSON.stringify({type: "control_hello", clientId: "tab-2"}), second);
  session.handleMessage(JSON.stringify({type: "data", data: "pwd\r"}), second);
  assert.equal(writes.includes("pwd\r"), false);
  assert.equal(messages.at(-1).type, "control_error");
  session.handleMessage("not-json", first);
  assert.equal(writes.length, 1);
  session.handleMessage(JSON.stringify({type: "resize", cols: 120, rows: 40}), second);
  assert.deepEqual(resizes, []);
  onData?.("output");
  onExit?.({exitCode: 0});
});
