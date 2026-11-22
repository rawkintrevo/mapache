import assert from "node:assert/strict";
import test from "node:test";
import {resolveLatestPackage, resolvePackageAtVersion, resolveStableRelease} from "./releaseResolver.mjs";

function fakeFetch(routes) {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		if (!(url in routes)) return {ok: false, status: 404, json: async () => ({})};
		return {ok: true, status: 200, json: async () => routes[url]};
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}

const manifest = {
	upstream: {
		repository: "https://github.com/xing-shuyin/pi-web-ui",
		releaseChannel: "stable",
		releaseApiUrl: "https://api.example.test/releases/latest",
		commitApiUrl: "https://api.example.test/commits/{tag}",
	},
};

test("resolves one stable release to its tag, commit, archive, and package version", async () => {
	const fetchImpl = fakeFetch({
		"https://api.example.test/releases/latest": {
			id: 452562659,
			tag_name: "v0.121.3",
			html_url: "https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.121.3",
			published_at: "2026-11-20T10:38:59Z",
		},
		"https://api.example.test/commits/v0.121.3": {sha: "a990160ea722abf587f7fc05308b209b743e6279"},
	});
	const release = await resolveStableRelease({manifest, fetchImpl, now: "2026-11-19T00:00:00Z"});
	assert.deepEqual(release, {
		channel: "stable",
		repository: "https://github.com/xing-shuyin/pi-web-ui",
		repositoryPath: "xing-shuyin/pi-web-ui",
		releaseId: 452562659,
		tag: "v0.121.3",
		version: "0.121.3",
		commit: "a990160ea722abf587f7fc05308b209b743e6279",
		archiveUrl: "https://github.com/xing-shuyin/pi-web-ui/archive/refs/tags/v0.121.3.tar.gz",
		releaseUrl: "https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.121.3",
		publishedAt: "2026-11-20T10:38:59Z",
		resolvedAt: "2026-11-19T00:00:00Z",
	});
});

test("rejects prereleases even when the release endpoint returns them", async () => {
	const fetchImpl = fakeFetch({
		"https://api.example.test/releases/latest": {tag_name: "v0.122.0-rc.1", prerelease: true},
	});
	await assert.rejects(
		() => resolveStableRelease({manifest, fetchImpl}),
		/release v0\.122\.0-rc\.1 is not stable/,
	);
});

test("rejects stable-release drift from the manifest target", async () => {
	const fetchImpl = fakeFetch({
		"https://api.example.test/releases/latest": {tag_name: "v0.121.4"},
		"https://api.example.test/commits/v0.121.4": {sha: "future"},
	});
	await assert.rejects(
		() => resolveStableRelease({
			manifest: {...manifest, upstream: {...manifest.upstream, version: "0.121.3"}},
			fetchImpl,
		}),
		/stable release version mismatch/,
	);
});

test("resolves the requested Pi SDK version and records its registry metadata", async () => {
	const fetchImpl = fakeFetch({
		"https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent": {
			"dist-tags": {latest: "1.7.0"},
			versions: {"1.6.0": {dist: {integrity: "sha512-sdk", tarball: "https://registry.example/sdk.tgz"}}},
		},
	});
	const sdk = await resolveLatestPackage({packageName: "@earendil-works/pi-coding-agent", expectedVersion: "1.6.0", fetchImpl, now: "2026-11-22T00:00:00Z"});
	assert.equal(sdk.version, "1.6.0");
	assert.equal(sdk.package, "@earendil-works/pi-coding-agent");
	assert.equal(sdk.integrity, "sha512-sdk");
});

test("records the installed package's own registry metadata", async () => {
	const fetchImpl = fakeFetch({
		"https://registry.npmjs.org/%40earendil-works%2Fpi-ai": {
			versions: {"1.6.0": {dist: {integrity: "sha512-ai", tarball: "https://registry.example/ai.tgz"}}},
		},
	});
	const metadata = await resolvePackageAtVersion({packageName: "@earendil-works/pi-ai", version: "1.6.0", fetchImpl});
	assert.equal(metadata.integrity, "sha512-ai");
});
