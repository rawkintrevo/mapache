"use strict";

const assert = require("assert");
const {
  cleanPreviewPathSegment,
  publicPreviewContentType,
  publicPreviewPath,
  shouldServePublicPreviewIndexFallback,
} = require("./preview.service");

assert.strictEqual(cleanPreviewPathSegment(" user/workspace "), "user-workspace");
assert.strictEqual(cleanPreviewPathSegment("../../unsafe"), "unsafe");
assert.strictEqual(cleanPreviewPathSegment("\u0000"), "unknown");

assert.strictEqual(publicPreviewPath("/assets\\app.js"), "assets/app.js");
assert.strictEqual(publicPreviewPath("app/../index.html"), "index.html");
assert.strictEqual(publicPreviewPath("../../secrets.txt"), "");
assert.strictEqual(publicPreviewPath("/"), "index.html");

const htmlRequest = {get: (name) => name === "accept" ? "text/html,application/xhtml+xml" : ""};
const assetRequest = {get: (name) => name === "accept" ? "*/*" : ""};
assert.strictEqual(shouldServePublicPreviewIndexFallback(htmlRequest, "dashboard"), true);
assert.strictEqual(shouldServePublicPreviewIndexFallback(htmlRequest, "dashboard.js"), true);
assert.strictEqual(shouldServePublicPreviewIndexFallback(assetRequest, "dashboard.js"), false);

assert.strictEqual(publicPreviewContentType("index.html"), "text/html; charset=utf-8");
assert.strictEqual(publicPreviewContentType("assets/app.js"), "text/javascript; charset=utf-8");
assert.strictEqual(publicPreviewContentType("assets/data.bin"), "application/octet-stream");

console.log("preview service tests passed");
