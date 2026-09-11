import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {applyPatches, buildUpstream} from "./build.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-test-"));
	writeFileSync(join(root, ".mapache-source-commit"), "wrong-revision\n");
	return root;
}

test("the build rejects a source directory with the wrong revision", async () => {
	const sourceDir = fixture();
	await assert.rejects(
		() => buildUpstream({sourceDir, verifyOnly: true}),
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
