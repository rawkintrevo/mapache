const DEFAULT_USER_AGENT = "mapache-pi-web-ui-builder";

function fail(message) {
	throw new Error(`pi-web-ui release resolution: ${message}`);
}

function stableVersion(value) {
	const version = String(value || "").trim().replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
	return version;
}

function requestHeaders() {
	return {
		accept: "application/vnd.github+json",
	"user-agent": DEFAULT_USER_AGENT,
	};
}

async function readJson(fetchImpl, url, label, headers = {}) {
	let response;
	try {
		response = await fetchImpl(url, {headers: {...requestHeaders(), ...headers}});
	} catch (error) {
		fail(`${label} request failed: ${error?.message || error}`);
	}
	if (!response?.ok) fail(`${label} request failed with HTTP ${response?.status ?? "unknown"}`);
	try {
		return await response.json();
	} catch (error) {
		fail(`${label} response was not valid JSON: ${error?.message || error}`);
	}
}

function repositoryPath(repository) {
	try {
		const url = new URL(repository);
		const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
		if (!path || path.split("/").length !== 2) fail(`repository is not an owner/name URL: ${repository}`);
		return path;
	} catch (error) {
		fail(`repository is not a valid URL: ${error?.message || repository}`);
	}
}

export async function resolveStableRelease({manifest, fetchImpl = globalThis.fetch, now = new Date().toISOString()} = {}) {
	const upstream = manifest?.upstream;
	if (!upstream?.releaseApiUrl || upstream.releaseChannel !== "stable") {
		fail("manifest must select the stable release channel and an API endpoint");
	}
	if (typeof fetchImpl !== "function") fail("fetch is unavailable");
	const release = await readJson(fetchImpl, upstream.releaseApiUrl, "stable release");
	if (release.draft === true || release.prerelease === true) {
		fail(`release ${release.tag_name || "(unnamed)"} is not stable`);
	}
	const tag = String(release.tag_name || "").trim();
	const version = stableVersion(tag);
	if (!version) fail(`stable release has an invalid tag: ${tag || "(empty)"}`);
	const commitUrl = String(upstream.commitApiUrl || "").replace("{tag}", encodeURIComponent(tag));
	if (!commitUrl || commitUrl === upstream.commitApiUrl) fail("manifest is missing commitApiUrl/{tag}");
	const commit = await readJson(fetchImpl, commitUrl, `commit for ${tag}`);
	const commitSha = String(commit.sha || "").trim();
	if (!/^[0-9a-f]{40}$/i.test(commitSha)) fail(`commit for ${tag} did not return a full SHA`);
	const repository = repositoryPath(upstream.repository);
	return {
		channel: upstream.releaseChannel,
		repository: upstream.repository,
		repositoryPath: repository,
		releaseId: release.id ?? null,
		tag,
		version,
		commit: commitSha,
		archiveUrl: `https://github.com/${repository}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`,
		releaseUrl: typeof release.html_url === "string" ? release.html_url : `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
		publishedAt: release.published_at || null,
		resolvedAt: now,
	};
}

export async function resolveLatestPackage({packageName, fetchImpl = globalThis.fetch, now = new Date().toISOString()} = {}) {
	if (!packageName) fail("package name is required");
	if (typeof fetchImpl !== "function") fail("fetch is unavailable");
	const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
	const packument = await readJson(fetchImpl, registryUrl, `npm package ${packageName}`, {
		accept: "application/vnd.npm.install-v1+json",
		"user-agent": DEFAULT_USER_AGENT,
	});
	const version = stableVersion(packument?.["dist-tags"]?.latest);
	if (!version) fail(`npm package ${packageName} has no stable latest version`);
	return packageMetadata({packageName, version, packument, now, registryUrl});
}

export async function resolvePackageAtVersion({packageName, version, fetchImpl = globalThis.fetch, now = new Date().toISOString()} = {}) {
	if (!packageName || !version) fail("package name and version are required");
	if (typeof fetchImpl !== "function") fail("fetch is unavailable");
	const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
	const packument = await readJson(fetchImpl, registryUrl, `npm package ${packageName}`, {
		accept: "application/vnd.npm.install-v1+json",
		"user-agent": DEFAULT_USER_AGENT,
	});
	return packageMetadata({packageName, version: stableVersion(version) || version, packument, now, registryUrl});
}

function packageMetadata({packageName, version, packument, now, registryUrl}) {
	const metadata = packument?.versions?.[version];
	const integrity = String(metadata?.dist?.integrity || "").trim();
	if (!metadata || !integrity) fail(`npm package ${packageName}@${version} is missing registry metadata`);
	return {
		package: packageName,
		version,
		integrity,
		tarball: metadata.dist.tarball || null,
		registryUrl,
		resolvedAt: now,
	};
}
