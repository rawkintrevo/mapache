import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {applyPatches, buildUpstream, readManifest} from "./build.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-test-"));
	writeFileSync(join(root, ".mapache-source-commit"), "wrong-revision\n");
	return root;
}

function release(overrides = {}) {
	return {
		tag: "v0.121.0",
		version: "0.121.0",
		commit: "6142308d81a1c85bd7c1ec180955ba5331cc650e",
		archiveUrl: "https://github.com/xing-shuyin/pi-web-ui/archive/refs/tags/v0.121.0.tar.gz",
		...overrides,
	};
}

test("the manifest is a release policy rather than a manually pinned source", () => {
	const manifest = readManifest();
	assert.equal(manifest.schemaVersion, 2);
	assert.equal(manifest.upstream.commit, undefined);
	assert.equal(manifest.upstream.archiveSha256, undefined);
	assert.equal(manifest.piSdk.version, undefined);
	assert.equal(manifest.piSdk.releaseChannel, "latest");
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

test("an incompatible resolved release fails before it can publish output", async () => {
	const sourceDir = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-release-test-"));
	const incompatible = release({
		tag: "v0.122.0",
		version: "0.122.0",
		commit: "6142308d81a1c85bd7c1ec180955ba5331cc650e",
	});
	writeFileSync(join(sourceDir, ".mapache-source-commit"), `${JSON.stringify(incompatible)}\n`);
	writeFileSync(join(sourceDir, "package.json"), JSON.stringify({name: "pi-web-ui", version: incompatible.version}));
	writeFileSync(join(sourceDir, "package-lock.json"), "{}\n");
	writeFileSync(join(sourceDir, "LICENSE"), "fixture\n");
	await assert.rejects(
		() => buildUpstream({sourceDir, verifyOnly: true, resolvedRelease: incompatible}),
		/patch baseline rejected/,
	);
});
