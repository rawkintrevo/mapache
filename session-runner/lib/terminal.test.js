"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {formatPrompt, renderTerminalPage} = require("./terminal");

test("formats Chat prompts as one bracketed paste followed by carriage return", () => {
  assert.equal(formatPrompt("one\ntwo"), "\x1b[200~one\ntwo\x1b[201~\r");
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
