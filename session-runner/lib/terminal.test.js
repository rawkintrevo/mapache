"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {renderTerminalPage} = require("./terminal");

test("renderTerminalPage includes critical xterm layout and helper-textarea styles", () => {
  const html = renderTerminalPage({accessToken: "token-123"});

  assert.match(html, /#terminal \.xterm-helper-textarea/);
  assert.match(html, /left: -9999em/);
  assert.match(html, /color: transparent/);
  assert.match(html, /caret-color: transparent/);
  assert.match(html, /#terminal \.xterm-viewport/);
  assert.match(html, /#terminal \.xterm-screen,\s*#terminal \.xterm-screen canvas/);
  assert.match(html, /helperTextarea\.addEventListener\("input", scheduleHelperTextareaClear, true\)/);
  assert.match(html, /term\.onRender\(\(\) => \{\s*applyHelperTextareaStyles\(\);/);
  assert.match(html, /mapache_access/);
});
