import assert from "node:assert/strict";
import {lstatSync, mkdtempSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {applyPatches, buildUpstream, copyRuntime, createCacheDecision, readManifest} from "./build.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-test-"));
	writeFileSync(join(root, ".mapache-source-commit"), "wrong-revision\n");
	return root;
}

function release(overrides = {}) {
	return {
		tag: "v9.8.7",
		version: "9.8.7",
		commit: "6a3a5e705f8084d2c9afee408b5c3dce9cf1e1c6",
		archiveUrl: "https://github.com/xing-shuyin/pi-web-ui/archive/refs/tags/v9.8.7.tar.gz",
		...overrides,
	};
}

test("the manifest is a release policy rather than a manually pinned source", () => {
	const manifest = readManifest();
	assert.equal(manifest.schemaVersion, 2);
	assert.equal(manifest.upstream.commit, undefined);
	assert.equal(manifest.upstream.archiveSha256, undefined);
	assert.equal(manifest.upstream.version, undefined);
	assert.equal(manifest.piSdk.version, "1.6.0");
	assert.equal(manifest.piSdk.releaseChannel, "latest");
});

test("fast cache misses are never publishable", () => {
	assert.equal(createCacheDecision({skipTests: true}).publishable, false);
	assert.equal(createCacheDecision({skipTests: false}).publishable, true);
});

test("the build rejects a source directory with the wrong revision", async () => {
	const sourceDir = fixture();
	await assert.rejects(
		() => buildUpstream({sourceDir, verifyOnly: true, resolvedRelease: release()}),
		/source revision mismatch/,
	);
});

test("the patch stage rejects a mismatched baseline", async () => {
	const sourceDir = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-patch-test-"));
	const patchRoot = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-patches-"));
	mkdirSync(join(patchRoot, "patches"));
	writeFileSync(join(sourceDir, "baseline.txt"), "different\n");
	writeFileSync(join(patchRoot, "patches", "fixture.patch"), [
		"diff --git a/baseline.txt b/baseline.txt",
		"--- a/baseline.txt",
		"+++ b/baseline.txt",
		"@@ -1 +1 @@",
		"-expected",
		"+patched",
		"",
	].join("\n"));
	await assert.rejects(
		() => applyPatches(sourceDir, {patches: ["patches/fixture.patch"]}, join(patchRoot, "patches")),
		/patch baseline rejected/,
	);
});

test("runtime copy rewrites absolute npm links to portable relative links", () => {
	const root = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-runtime-copy-test-"));
	const sourceDir = join(root, "source");
	const outputDir = join(root, "output");
	mkdirSync(join(sourceDir, "node_modules", "demo"), {recursive: true});
	writeFileSync(join(sourceDir, "node_modules", "demo", "cli.js"), "#!/usr/bin/env node\n");
	mkdirSync(join(sourceDir, "node_modules", ".bin"), {recursive: true});
	symlinkSync(join(sourceDir, "node_modules", "demo", "cli.js"), join(sourceDir, "node_modules", ".bin", "demo"));
	copyRuntime(sourceDir, outputDir, {build: {runtimeEntries: ["node_modules"]}});
	const copiedLink = join(outputDir, "node_modules", ".bin", "demo");
	assert.equal(lstatSync(copiedLink).isSymbolicLink(), true);
	assert.equal(readlinkSync(copiedLink), "../demo/cli.js");
});
