#!/usr/bin/env node

import {createHash} from "node:crypto";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {resolveLatestPackage, resolvePackageAtVersion, resolveStableRelease} from "./releaseResolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const PATCH_ROOT = join(HERE, "patches");

function fail(message) {
	throw new Error("pi-web-ui build: " + message);
}
export function readManifest(manifestPath = MANIFEST_PATH) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.schemaVersion !== 2) fail("unsupported manifest schema");
	const upstream = manifest.upstream;
	if (!upstream?.repository || upstream.releaseChannel !== "stable" || !upstream.releaseApiUrl || !upstream.commitApiUrl?.includes("{tag}")) {
		fail("manifest must resolve the stable upstream release at build time");
	}
	if (upstream.commit || upstream.packageVersion || upstream.archiveUrl || upstream.archiveSha256 || upstream.files) {
		fail("manifest contains a manually pinned upstream release; keep resolved values in build-info.json only");
	}
	if (!upstream.packageName || !Array.isArray(upstream.requiredFiles) || upstream.requiredFiles.length === 0) {
		fail("manifest is missing upstream package identity or required files");
	}
	if (!manifest.piSdk?.package || manifest.piSdk.releaseChannel !== "latest") {
		fail("manifest must resolve the embedded Pi SDK from the latest npm channel");
	}
	if (!manifest.piMcpAdapter?.package || !manifest.piMcpAdapter.version || !manifest.piMcpAdapter.integrity) {
		fail("manifest is missing the managed MCP adapter compatibility contract");
	}
	if (!manifest.patches?.length) fail("manifest is missing integration patches");
	if (!manifest.build?.runtimeEntries?.length) fail("manifest is missing runtime entries");
	return manifest;
}

function sha256File(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Buffer(value) {
	return createHash("sha256").update(value).digest("hex");
}

function assertHash(label, actual, expected) {
	if (actual !== expected) fail(label + " hash mismatch (expected " + expected + ", got " + actual + ")");
}

async function download(url, destination, fetchImpl = globalThis.fetch) {
	let response;
	try {
		response = await fetchImpl(url, {headers: {"user-agent": "mapache-pi-web-ui-builder"}});
	} catch (error) {
		fail("source download failed: " + (error?.message || error));
	}
	if (!response?.ok) fail("source download failed with HTTP " + (response?.status ?? "unknown"));
	const body = Buffer.from(await response.arrayBuffer());
	writeFileSync(destination, body);
	return body;
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {cwd: options.cwd, env: options.env, stdio: options.stdio || "inherit"});
		child.on("error", rejectRun);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolveRun();
				return;
			}
			rejectRun(new Error(command + " " + args.join(" ") + " failed (" + (signal || code) + ")"));
		});
	});
}

function readMarker(sourceDir) {
	const markerPath = join(sourceDir, ".mapache-source-commit");
	if (!existsSync(markerPath)) return null;
	const raw = readFileSync(markerPath, "utf8").trim();
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// Older local fixtures used a plain commit string.
	}
	return {commit: raw};
}

async function gitRevision(sourceDir) {
	if (!existsSync(join(sourceDir, ".git"))) return null;
	let stdout = "";
	await new Promise((resolveRun, rejectRun) => {
		const child = spawn("git", ["rev-parse", "HEAD"], {cwd: sourceDir, stdio: ["ignore", "pipe", "pipe"]});
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", rejectRun);
		child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr || "git rev-parse failed (" + code + ")")));
	});
	return stdout.trim();
}

async function verifyCommitMarker(sourceDir, expectedRelease) {
	const expectedCommit = typeof expectedRelease === "string" ? expectedRelease : expectedRelease.commit;
	const marker = readMarker(sourceDir);
	if (marker?.commit && marker.commit !== expectedCommit) {
		fail("source revision mismatch (expected " + expectedCommit + ", got " + marker.commit + ")");
	}
	if (marker?.tag && expectedRelease.tag && marker.tag !== expectedRelease.tag) {
		fail("source release tag mismatch (expected " + expectedRelease.tag + ", got " + marker.tag + ")");
	}
	if (!marker) {
		const revision = await gitRevision(sourceDir);
		if (revision && revision !== expectedCommit) {
			fail("source revision mismatch (expected " + expectedCommit + ", got " + revision + ")");
		}
		if (!revision) fail("source revision cannot be verified; provide a checked-out commit or .mapache-source-commit");
	}
}

function verifySourceFiles(sourceDir, manifest, release) {
	const sourceFiles = {};
	for (const relativePath of manifest.upstream.requiredFiles) {
		if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
			fail("invalid required source path: " + relativePath);
		}
		const filePath = join(sourceDir, relativePath);
		if (!existsSync(filePath)) fail("required upstream source file is missing: " + relativePath);
		sourceFiles[relativePath] = sha256File(filePath);
	}
	const packagePath = join(sourceDir, "package.json");
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
	if (packageJson.name !== manifest.upstream.packageName) {
		fail("upstream package name mismatch (expected " + manifest.upstream.packageName + ", got " + packageJson.name + ")");
	}
	if (packageJson.version !== release.version) {
		fail("upstream package version mismatch (expected " + release.version + ", got " + packageJson.version + ")");
	}
	return {packageJson, sourceFiles};
}

export async function applyPatches(sourceDir, manifest, patchRoot = PATCH_ROOT) {
	for (const relativePatch of manifest.patches) {
		const patchPath = join(patchRoot, relativePatch.replace(/^patches\//, ""));
		if (!existsSync(patchPath)) fail("patch is missing: " + relativePatch);
		try {
			await run("git", ["apply", "--check", "--recount", "--whitespace=nowarn", patchPath], {cwd: sourceDir, stdio: "pipe"});
			await run("git", ["apply", "--recount", "--whitespace=nowarn", patchPath], {cwd: sourceDir, stdio: "pipe"});
		} catch (error) {
			fail("patch baseline rejected for " + relativePatch + ": " + error.message);
		}
	}
}

function packagePath(root, packageName) {
	return join(root, "node_modules", ...packageName.split("/"), "package.json");
}

function readInstalledPackage(root, packageName) {
	const candidates = [
		packagePath(root, packageName),
		join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", ...packageName.split("/"), "package.json"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8"));
	}
	fail("installed package is missing: " + packageName);
}

function adapterMetadata(manifest) {
	const packageRoot = process.env.PI_MCP_ADAPTER_DIR ||
		join(process.env.HOME || "/root", ".pi", "agent", "npm", "node_modules", manifest.piMcpAdapter.package);
	const packageJsonPath = join(packageRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		if (process.env.MAPACHE_REQUIRE_ADAPTER_INSPECTION === "1") {
			fail("managed MCP adapter is missing from the image build environment: " + packageRoot);
		}
		return {
			package: manifest.piMcpAdapter.package,
			version: manifest.piMcpAdapter.version,
			integrity: manifest.piMcpAdapter.integrity,
			inspected: false,
		};
	}
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	if (packageJson.name !== manifest.piMcpAdapter.package || packageJson.version !== manifest.piMcpAdapter.version) {
		fail("managed MCP adapter mismatch (expected " + manifest.piMcpAdapter.package + "@" + manifest.piMcpAdapter.version +
			", got " + packageJson.name + "@" + packageJson.version + ")");
	}
	const expectedPeers = manifest.piMcpAdapter.peerCompatibility || {};
	const actualPeers = packageJson.peerDependencies || {};
	const expectedPeerNames = Object.keys(expectedPeers).sort();
	const actualPeerNames = Object.keys(actualPeers).sort();
	if (JSON.stringify(actualPeerNames) !== JSON.stringify(expectedPeerNames)) {
		fail("managed MCP adapter peer dependency contract changed (expected " + expectedPeerNames.join(", ") +
			", got " + actualPeerNames.join(", ") + ")");
	}
	for (const peerName of expectedPeerNames) {
		if (actualPeers[peerName] !== expectedPeers[peerName]) {
			fail("managed MCP adapter peer dependency changed for " + peerName + " (expected " + expectedPeers[peerName] +
				", got " + actualPeers[peerName] + ")");
		}
	}
	return {
		package: packageJson.name,
		version: packageJson.version,
		integrity: manifest.piMcpAdapter.integrity,
		peerDependencies: actualPeers,
		peerDependenciesMeta: packageJson.peerDependenciesMeta || {},
		inspected: true,
	};
}

function writeBuildInfo(sourceDir, manifest, release, sourceFiles, sdk, piAi, adapter) {
	const info = {
		schemaVersion: 2,
		upstreamCommit: release.commit,
		packageVersion: release.version,
		piSdkVersion: sdk.version,
		piMcpAdapterVersion: adapter.version,
		upstream: {
			repository: release.repository,
			channel: release.channel,
			tag: release.tag,
			version: release.version,
			commit: release.commit,
			releaseId: release.releaseId,
			releaseUrl: release.releaseUrl,
			publishedAt: release.publishedAt,
			resolvedAt: release.resolvedAt,
			archiveUrl: release.archiveUrl,
			archiveSha256: release.archiveSha256 || null,
			sourceFiles,
		},
		piSdk: sdk,
		piAi,
		piMcpAdapter: adapter,
		patches: manifest.patches,
	};
	writeFileSync(join(sourceDir, "build-info.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
}

function copyRuntime(sourceDir, outputDir, manifest) {
	if (existsSync(outputDir) && readdirSync(outputDir).length > 0) fail("output directory is not empty: " + outputDir);
	mkdirSync(outputDir, {recursive: true});
	for (const relativePath of manifest.build.runtimeEntries) {
		const sourcePath = join(sourceDir, relativePath);
		if (!existsSync(sourcePath)) fail("runtime output is missing: " + relativePath);
		cpSync(sourcePath, join(outputDir, relativePath), {recursive: true, dereference: true});
	}
}

function parseArgs(argv) {
	const options = {manifestPath: MANIFEST_PATH, outputDir: "", sourceDir: "", workDir: "", verifyOnly: false, skipTests: false};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--verify-only") options.verifyOnly = true;
		else if (arg === "--skip-tests") options.skipTests = true;
		else if (arg === "--manifest") options.manifestPath = argv[++index] || fail("--manifest requires a path");
		else if (arg === "--output-dir") options.outputDir = argv[++index] || fail("--output-dir requires a path");
		else if (arg === "--source-dir") options.sourceDir = argv[++index] || fail("--source-dir requires a path");
		else if (arg === "--work-dir") options.workDir = argv[++index] || fail("--work-dir requires a path");
		else fail("unknown option: " + arg);
	}
	if (!options.verifyOnly && !options.outputDir) fail("--output-dir is required unless --verify-only is used");
	return options;
}

function resolvedReleaseShape(release) {
	if (!release?.commit || !release?.tag || !release?.version || !release?.archiveUrl) {
		fail("release resolver returned incomplete metadata");
	}
	return release;
}

export async function buildUpstream(options = {}) {
	const manifest = readManifest(options.manifestPath || MANIFEST_PATH);
	const fetchImpl = options.fetchImpl || globalThis.fetch;
	const workDir = options.workDir ? resolve(options.workDir) : mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-"));
	const sourceDir = options.sourceDir ? resolve(options.sourceDir) : join(workDir, "source");
	const ownsWorkDir = !options.workDir;
	try {
		mkdirSync(workDir, {recursive: true});
		const release = resolvedReleaseShape(options.resolvedRelease || await resolveStableRelease({manifest, fetchImpl}));
		let resolvedSource = release;
		if (options.sourceDir) {
			await verifyCommitMarker(sourceDir, release);
		} else {
			const sourceArchive = join(workDir, "source.tar.gz");
			mkdirSync(sourceDir, {recursive: true});
			const body = await download(release.archiveUrl, sourceArchive, fetchImpl);
			resolvedSource = {...release, archiveSha256: sha256Buffer(body)};
			await run("tar", ["-xzf", sourceArchive, "-C", sourceDir, "--strip-components=1"], {stdio: "pipe"});
			writeFileSync(join(sourceDir, ".mapache-source-commit"), JSON.stringify({
				tag: release.tag,
				commit: release.commit,
				packageVersion: release.version,
			}) + "\n", "utf8");
		}
		const {sourceFiles} = verifySourceFiles(sourceDir, manifest, resolvedSource);
		await applyPatches(sourceDir, manifest);
		if (options.verifyOnly) {
			return {
				commit: resolvedSource.commit,
				tag: resolvedSource.tag,
				packageVersion: resolvedSource.version,
				archiveSha256: resolvedSource.archiveSha256 || null,
			};
		}

		const sdk = await resolveLatestPackage({
			packageName: manifest.piSdk.package,
			fetchImpl,
		});
		await run("npm", ["ci"], {cwd: sourceDir});
		await run("npm", ["install", "--no-save", "--package-lock=false", "--ignore-scripts", sdk.package + "@" + sdk.version], {cwd: sourceDir});
		if (existsSync(join(sourceDir, "mobile", "package.json"))) {
			await run("npm", ["ci", "--ignore-scripts", "--prefix", "mobile"], {cwd: sourceDir});
		}

		const installedSdk = readInstalledPackage(sourceDir, sdk.package);
		if (installedSdk.name !== sdk.package || installedSdk.version !== sdk.version) {
			fail("installed Pi SDK mismatch (expected " + sdk.package + "@" + sdk.version + ", got " + installedSdk.name + "@" + installedSdk.version + ")");
		}
		const installedPiAi = readInstalledPackage(sourceDir, "@earendil-works/pi-ai");
		const piAi = await resolvePackageAtVersion({
			packageName: "@earendil-works/pi-ai",
			version: installedPiAi.version,
			fetchImpl,
		});
		const adapter = adapterMetadata(manifest);
		writeBuildInfo(sourceDir, manifest, resolvedSource, sourceFiles, {
			package: sdk.package,
			version: installedSdk.version,
			integrity: sdk.integrity,
			tarball: sdk.tarball,
			registryUrl: sdk.registryUrl,
			resolvedAt: sdk.resolvedAt,
		}, {
			package: piAi.package,
			version: installedPiAi.version,
			integrity: piAi.integrity,
			tarball: piAi.tarball,
			registryUrl: piAi.registryUrl,
			resolvedAt: piAi.resolvedAt,
		}, adapter);
		await run("npm", ["run", "typecheck"], {cwd: sourceDir});
		if (!options.skipTests) await run("npm", ["test"], {cwd: sourceDir});
		const webBasePath = manifest.build?.webBasePath;
		if (typeof webBasePath !== "string" || !/^\/[A-Za-z0-9._~-]+\/$/.test(webBasePath)) {
			fail("manifest build.webBasePath must be a single slash-delimited path");
		}
		await run("npm", ["run", "build"], {
			cwd: sourceDir,
			env: {...process.env, PI_WEB_BASE_PATH: webBasePath},
		});
		const outputDir = resolve(options.outputDir);
		copyRuntime(sourceDir, outputDir, manifest);
		return {
			commit: resolvedSource.commit,
			tag: resolvedSource.tag,
			packageVersion: resolvedSource.version,
			piSdkVersion: installedSdk.version,
			piAiVersion: installedPiAi.version,
			piMcpAdapterVersion: adapter.version,
			outputDir,
		};
	} finally {
		if (ownsWorkDir) rmSync(workDir, {recursive: true, force: true});
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	buildUpstream(parseArgs(process.argv.slice(2)))
		.then((result) => console.log(JSON.stringify({ok: true, ...result})))
		.catch((error) => {
			console.error("✗ " + error.message);
			process.exitCode = 1;
		});
}
