"use strict";

const assert = require("assert");
const {
  normalizePiPackageSource,
  piPackageCatalogDocId,
  buildCatalogMerge,
} = require("./packageCatalog.helpers");

function code(fn) {
  try {
    fn();
  } catch (error) {
    return error.code || error.message;
  }
  return "";
}

assert.deepStrictEqual(normalizePiPackageSource("npm:eslint"), {
  source: "npm:eslint",
  type: "npm",
  identity: "npm:eslint",
  name: "eslint",
  pinned: false,
});
assert.strictEqual(normalizePiPackageSource("npm:@scope/tool").identity, "npm:@scope/tool");
assert.strictEqual(normalizePiPackageSource("npm:@scope/tool@1.2.3").pinned, true);
assert.strictEqual(normalizePiPackageSource("git:github:owner/repo#main").identity, "git:github.com/owner/repo");
assert.strictEqual(normalizePiPackageSource("git+https://github.com/Owner/Repo.git#v1").pinned, true);
assert.strictEqual(code(() => normalizePiPackageSource("https://user:secret@example.com/repo.git")), "package_source_must_not_include_credentials");
assert.strictEqual(code(() => normalizePiPackageSource("../local")), "unsupported_package_source");
assert.strictEqual(code(() => normalizePiPackageSource("npm:bad/name")), "invalid_package_source");

const catalog = buildCatalogMerge("npm:@scope/tool@1.2.3", "workspace-1", {
  includeCreatedAt: true,
  incrementInstallCount: true,
});
assert.strictEqual(catalog.source, "npm:@scope/tool@1.2.3");
assert.strictEqual(catalog.identity, "npm:@scope/tool");
assert.strictEqual(catalog.type, "npm");
assert.strictEqual(catalog.lastWorkspaceId, "workspace-1");
assert.strictEqual(catalog.installCountIncrement, 1);
assert.strictEqual(catalog.favorite, false);
assert.strictEqual(piPackageCatalogDocId("git:github.com/owner/repo"), "git%3Agithub.com%2Fowner%2Frepo");

console.log("package catalog helper tests passed");
