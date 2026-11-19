import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
	cacheKey,
	packCacheArtifact,
	restoreCacheArtifact,
	sha256Buffer,
} from "./artifactCache.mjs";

function runtimeFixture() {
	const root = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-cache-test-"));
	mkdirSync(join(root, "dist", "server"), {recursive: true});
	writeFileSync(join(root, "dist", "server", "index.js"), "console.log('fixture');\n");
	writeFileSync(join(root, "build-info.json"), JSON.stringify({
		cacheKey: "fixture-key",
		cacheIdentitySha256: "fixture-identity",
		upstreamCommit: "source-commit",
		packageVersion: "1.0.0",
		piSdkVersion: "1.0.0",
		piAi: {version: "1.0.0"},
		piMcpAdapterVersion: "2.32.1",
	}) + "\n");
	return root;
}

test("cache keys change when a resolved input changes", () => {
	const base = {upstream: {commit: "a"}, dependencyTree: {sdk: "1"}, patches: [{sha256: "p"}], environment: {node: "24"}};
	assert.notEqual(cacheKey(base), cacheKey({...base, upstream: {commit: "b"}}));
	assert.notEqual(cacheKey(base), cacheKey({...base, dependencyTree: {sdk: "2"}}));
	assert.notEqual(cacheKey(base), cacheKey({...base, patches: [{sha256: "q"}]}));
});

test("a packed artifact restores only when its manifest and runtime checksums verify", async () => {
	const runtime = runtimeFixture();
	const archive = join(runtime, "cache.tar.gz");
	const restored = join(runtime, "restored");
	await packCacheArtifact({
		runtimeDir: runtime,
		outputPath: archive,
		expectedKey: "fixture-key",
		expectedIdentitySha256: "fixture-identity",
	});
	const hit = await restoreCacheArtifact({
		archivePath: archive,
		outputDir: restored,
		expectedKey: "fixture-key",
		expectedIdentitySha256: "fixture-identity",
		requiredRuntimeEntries: ["build-info.json", "dist/server/index.js"],
	});
	assert.equal(hit.status, "hit");
	assert.equal(readFileSync(join(restored, "dist/server/index.js"), "utf8"), "console.log('fixture');\n");
	assert.ok(hit.elapsedMs >= 0);
});

test("a missing or tampered artifact is a miss", async () => {
	const root = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-cache-miss-test-"));
	const missing = await restoreCacheArtifact({
		archivePath: join(root, "missing.tar.gz"),
		outputDir: join(root, "output"),
		expectedKey: "fixture-key",
	});
	assert.equal(missing.status, "miss");
	assert.equal(missing.reason, "missing");
	const archive = join(root, "tampered.tar.gz");
	writeFileSync(archive, Buffer.from("not an archive"));
	const tampered = await restoreCacheArtifact({
		archivePath: archive,
		outputDir: join(root, "tampered-output"),
		expectedKey: "fixture-key",
	});
	assert.equal(tampered.status, "miss");
	assert.match(tampered.reason, /^unreadable:/);
	assert.equal(sha256Buffer(readFileSync(archive)).length, 64);
});
