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
			id: 121,
			tag_name: "v0.121.0",
			html_url: "https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.121.0",
			published_at: "2026-11-14T00:00:00Z",
		},
		"https://api.example.test/commits/v0.121.0": {sha: "6142308d81a1c85bd7c1ec180955ba5331cc650e"},
	});
	const release = await resolveStableRelease({manifest, fetchImpl, now: "2026-11-19T00:00:00Z"});
	assert.deepEqual(release, {
		channel: "stable",
		repository: "https://github.com/xing-shuyin/pi-web-ui",
		repositoryPath: "xing-shuyin/pi-web-ui",
		releaseId: 121,
		tag: "v0.121.0",
		version: "0.121.0",
		commit: "6142308d81a1c85bd7c1ec180955ba5331cc650e",
		archiveUrl: "https://github.com/xing-shuyin/pi-web-ui/archive/refs/tags/v0.121.0.tar.gz",
		releaseUrl: "https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.121.0",
		publishedAt: "2026-11-14T00:00:00Z",
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

test("resolves npm latest without coupling it to the upstream release version", async () => {
	const fetchImpl = fakeFetch({
		"https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent": {
			"dist-tags": {latest: "1.5.2"},
			versions: {"1.5.2": {dist: {integrity: "sha512-sdk", tarball: "https://registry.example/sdk.tgz"}}},
		},
	});
	const sdk = await resolveLatestPackage({packageName: "@earendil-works/pi-coding-agent", fetchImpl, now: "2026-11-19T00:00:00Z"});
	assert.equal(sdk.version, "1.5.2");
	assert.equal(sdk.package, "@earendil-works/pi-coding-agent");
	assert.equal(sdk.integrity, "sha512-sdk");
});

test("records the installed package's own registry metadata", async () => {
	const fetchImpl = fakeFetch({
		"https://registry.npmjs.org/%40earendil-works%2Fpi-ai": {
			versions: {"1.5.2": {dist: {integrity: "sha512-ai", tarball: "https://registry.example/ai.tgz"}}},
		},
	});
	const metadata = await resolvePackageAtVersion({packageName: "@earendil-works/pi-ai", version: "1.5.2", fetchImpl});
	assert.equal(metadata.integrity, "sha512-ai");
});
