"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createPreviewLogService} = require("./previewLog.service");

test("preview log service normalizes entries and enforces its limit", () => {
  const service = createPreviewLogService({previewBasePath: "/preview", previewLogLimit: 2});

  service.appendLog({args: ["one"], level: "warning", href: "https://preview.test/"});
  service.appendLog({args: ["two"], level: "ERROR"});
  service.appendLog({args: ["three"], level: "info"});

  assert.equal(service.logs.length, 2);
  assert.equal(service.logs[0].args[0], "two");
  assert.equal(service.logs[0].level, "error");
  assert.equal(service.logs[1].level, "info");
});

test("preview log streams replay entries and stop writing after disconnect", () => {
  const service = createPreviewLogService({previewBasePath: "/preview", previewLogLimit: 10});
  service.appendLog({args: ["before"]});
  const writes = [];
  let closeHandler;
  const req = {
    on(event, handler) {
      if (event === "close") closeHandler = handler;
    },
  };
  const res = {
    write: (chunk) => writes.push(chunk),
    writeHead: (status, headers) => {
      assert.equal(status, 200);
      assert.equal(headers["Content-Type"], "text/event-stream");
    },
  };

  service.streamLogs(req, res);
  assert.equal(writes.length, 1);
  closeHandler();
  service.appendLog({args: ["after"]});
  assert.equal(writes.length, 1);
});

test("preview logger injection preserves token propagation and HTML placement", () => {
  const service = createPreviewLogService({previewBasePath: "/preview", previewLogLimit: 10});

  const injected = service.injectHtmlLogger("<html><head></head><body></body></html>", "signed token");

  assert.match(injected, /mapache_access=signed%20token/);
  assert.equal((injected.match(/window\.__mapachePreviewLoggerInstalled = true/g) || []).length, 1);
  assert.ok(injected.indexOf("</head>") > injected.indexOf("__mapachePreviewLoggerInstalled"));
});
