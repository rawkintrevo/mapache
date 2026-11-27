#!/usr/bin/env node

import {createHash} from "node:crypto";
import {cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {restoreCacheArtifact, updateCacheDecision} from "./artifactCache.mjs";
import {resolveLatestPackage, resolvePackageAtVersion, resolveStableRelease} from "./releaseResolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const PATCH_ROOT = join(HERE, "patches");

function fail(message) {
	throw new Error("pi-web-ui build: " + message);
}

export function createCacheDecision({skipTests = false} = {}) {
	return {
		status: "disabled",
		reason: skipTests ? "tests-skipped" : "no-build-inputs",
		elapsedMs: 0,
		publishable: !skipTests,
	};
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
	if (manifest.piSdk.version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(manifest.piSdk.version))) {
		fail("manifest has an invalid Pi SDK version");
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

function writeBuildInfo(sourceDir, manifest, release, sourceFiles, sdk, piAi, adapter, cache = {}) {
	const info = {
		schemaVersion: 2,
		upstreamCommit: release.commit,
		packageVersion: release.version,
		piSdkVersion: sdk.version,
		piMcpAdapterVersion: adapter.version,
		cacheKey: cache.key || null,
		cacheIdentitySha256: cache.identitySha256 || null,
		cacheDecision: cache.decision || {status: "disabled", reason: "no-build-inputs"},
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

function copyRuntimeEntry(sourcePath, destinationPath, sourceRoot, destinationRoot) {
	const entry = lstatSync(sourcePath);
	if (entry.isSymbolicLink()) {
		const target = readlinkSync(sourcePath);
		const targetPath = resolve(dirname(sourcePath), target);
		const sourceRootPath = resolve(sourceRoot);
		if (targetPath !== sourceRootPath && !targetPath.startsWith(`${sourceRootPath}/`)) {
			fail(`runtime link escapes the source tree: ${sourcePath} -> ${target}`);
		}
		try {
			lstatSync(targetPath);
		} catch {
			fail(`runtime link target is missing: ${sourcePath} -> ${target}`);
		}
		const mappedTarget = join(resolve(destinationRoot), relative(sourceRootPath, targetPath));
		const portableTarget = relative(dirname(destinationPath), mappedTarget) || ".";
		mkdirSync(dirname(destinationPath), {recursive: true});
		symlinkSync(portableTarget, destinationPath);
		return;
	}
	if (entry.isDirectory()) {
		mkdirSync(destinationPath, {recursive: true});
		for (const name of readdirSync(sourcePath).sort()) {
			copyRuntimeEntry(join(sourcePath, name), join(destinationPath, name), sourceRoot, destinationRoot);
		}
		return;
	}
	if (!entry.isFile()) fail(`runtime output contains an unsupported entry: ${sourcePath}`);
	mkdirSync(dirname(destinationPath), {recursive: true});
	cpSync(sourcePath, destinationPath);
}

async function prepareSourceForTests(sourceDir) {
	// Release archives are intentionally extracted without .git metadata. Keep the
	// upstream repository-hygiene tests meaningful by giving them a temporary index,
	// while keeping the resolver marker out of the source tree's root allowlist.
	rmSync(join(sourceDir, ".mapache-source-commit"), {force: true});
	if (existsSync(join(sourceDir, ".git"))) return;
	await run("git", ["init", "--quiet"], {cwd: sourceDir, stdio: "pipe"});
	await run("git", ["add", "--all"], {cwd: sourceDir, stdio: "pipe"});
}

export function copyRuntime(sourceDir, outputDir, manifest) {
	if (existsSync(outputDir) && readdirSync(outputDir).length > 0) fail("output directory is not empty: " + outputDir);
	mkdirSync(outputDir, {recursive: true});
	for (const relativePath of manifest.build.runtimeEntries) {
		const sourcePath = join(sourceDir, relativePath);
		try {
			lstatSync(sourcePath);
		} catch {
			fail("runtime output is missing: " + relativePath);
		}
		copyRuntimeEntry(sourcePath, join(outputDir, relativePath), sourceDir, outputDir);
	}
}

function parseArgs(argv) {
	const options = {
		manifestPath: MANIFEST_PATH,
		outputDir: "",
		sourceDir: "",
		workDir: "",
		buildInputsPath: "",
		cacheArchivePath: "",
		verifyOnly: false,
		skipTests: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--verify-only") options.verifyOnly = true;
		else if (arg === "--skip-tests") options.skipTests = true;
		else if (arg === "--manifest") options.manifestPath = argv[++index] || fail("--manifest requires a path");
		else if (arg === "--output-dir") options.outputDir = argv[++index] || fail("--output-dir requires a path");
		else if (arg === "--source-dir") options.sourceDir = argv[++index] || fail("--source-dir requires a path");
		else if (arg === "--work-dir") options.workDir = argv[++index] || fail("--work-dir requires a path");
		else if (arg === "--build-inputs") options.buildInputsPath = argv[++index] || fail("--build-inputs requires a path");
		else if (arg === "--cache-archive") options.cacheArchivePath = argv[++index] || fail("--cache-archive requires a path");
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
	const buildInputs = readBuildInputs(options.buildInputsPath, manifest);
	const workDir = options.workDir ? resolve(options.workDir) : mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-"));
	const sourceDir = options.sourceDir ? resolve(options.sourceDir) : join(workDir, "source");
	const ownsWorkDir = !options.workDir;
	try {
		mkdirSync(workDir, {recursive: true});
		const release = resolvedReleaseShape(options.resolvedRelease || buildInputs?.release || await resolveStableRelease({manifest, fetchImpl}));
		let resolvedSource = release;
		if (options.sourceDir) {
			await verifyCommitMarker(sourceDir, release);
		} else {
			const sourceArchive = join(workDir, "source.tar.gz");
			mkdirSync(sourceDir, {recursive: true});
			const body = await download(release.archiveUrl, sourceArchive, fetchImpl);
			resolvedSource = {...release, archiveSha256: sha256Buffer(body)};
			if (buildInputs?.release?.archiveSha256 && buildInputs.release.archiveSha256 !== resolvedSource.archiveSha256) {
				fail("resolved source archive changed after cache-key computation");
			}
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

		const sdk = options.resolvedSdk || buildInputs?.piSdk || await resolveLatestPackage({
			packageName: manifest.piSdk.package,
			expectedVersion: manifest.piSdk.version,
			fetchImpl,
		});
		if (manifest.piSdk.version && sdk.version !== manifest.piSdk.version) {
			fail(`resolved Pi SDK version mismatch (expected ${manifest.piSdk.version}, got ${sdk.version})`);
		}
		const cacheKey = buildInputs?.cacheKey || null;
		const cacheIdentitySha256 = buildInputs?.identitySha256 || null;
		const cacheLookupStartedAt = Date.now();
		let cacheDecision = createCacheDecision({skipTests: options.skipTests});
		const webBasePath = manifest.build?.webBasePath;
		if (typeof webBasePath !== "string" || !/^\/[A-Za-z0-9._~-]+\/$/.test(webBasePath)) {
			fail("manifest build.webBasePath must be a single slash-delimited path");
		}
		const adapter = adapterMetadata(manifest);
		if (cacheKey && options.cacheArchivePath && options.outputDir) {
			const cached = await restoreCacheArtifact({
				archivePath: options.cacheArchivePath,
				outputDir: options.outputDir,
				expectedKey: cacheKey,
				expectedIdentitySha256: cacheIdentitySha256,
				requiredRuntimeEntries: manifest.build.runtimeEntries,
			});
			cacheDecision = {
				...cacheDecision,
				status: cached.status,
				reason: cached.reason,
				elapsedMs: cached.elapsedMs,
			};
			console.log(`pi-web-ui cache decision=${cached.status} reason=${cached.reason} key=${cacheKey} elapsedMs=${cached.elapsedMs}`);
			if (cached.status === "hit") {
				const expectedBuildInfo = cached.buildInfo || {};
				const expectedPiAiVersion = buildInputs?.piAi?.version || expectedBuildInfo.piAi?.version || "";
				if (expectedBuildInfo.upstreamCommit !== resolvedSource.commit ||
					expectedBuildInfo.packageVersion !== resolvedSource.version ||
					expectedBuildInfo.piSdkVersion !== sdk.version ||
					(expectedPiAiVersion && expectedBuildInfo.piAi?.version !== expectedPiAiVersion) ||
					expectedBuildInfo.piMcpAdapterVersion !== adapter.version) {
					rmSync(resolve(options.outputDir), {recursive: true, force: true});
					cacheDecision = {
						...cacheDecision,
						status: "miss",
						reason: "cached-build-info-metadata-mismatch",
						elapsedMs: Date.now() - cacheLookupStartedAt,
					};
					console.log(`pi-web-ui cache decision=miss reason=${cacheDecision.reason} key=${cacheKey} elapsedMs=${cacheDecision.elapsedMs}`);
				} else {
					updateCacheDecision(options.outputDir, cacheDecision);
					return {
						commit: resolvedSource.commit,
						tag: resolvedSource.tag,
						packageVersion: resolvedSource.version,
						piSdkVersion: sdk.version,
						piAiVersion: expectedPiAiVersion,
						piMcpAdapterVersion: adapter.version,
						outputDir: resolve(options.outputDir),
						cache: cacheDecision,
						cacheKey,
					};
				}
			}
		}
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
		const buildStartedAt = Date.now();
		await run("npm", ["run", "typecheck"], {cwd: sourceDir});
		await run("npm", ["run", "build"], {
			cwd: sourceDir,
			env: {...process.env, PI_WEB_BASE_PATH: webBasePath},
		});
		if (!options.skipTests) {
			await prepareSourceForTests(sourceDir);
			await run("npm", ["test"], {
				cwd: sourceDir,
				env: {...process.env, HOME: "/tmp/mapache-build-home", LC_ALL: ""},
			});
		}
		cacheDecision = {
			...cacheDecision,
			buildElapsedMs: Date.now() - buildStartedAt,
		};
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
		}, adapter, {
			key: cacheKey,
			identitySha256: cacheIdentitySha256,
			decision: cacheDecision,
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
			cache: cacheDecision,
			cacheKey,
		};
	} finally {
		if (ownsWorkDir) rmSync(workDir, {recursive: true, force: true});
	}
}

function readBuildInputs(buildInputsPath, manifest) {
	if (!buildInputsPath) return null;
	try {
		const inputs = JSON.parse(readFileSync(resolve(buildInputsPath), "utf8"));
		if (inputs?.schemaVersion !== 1 || !inputs.cacheKey || !inputs.identitySha256 || !inputs.release || !inputs.piSdk ||
			(manifest.piSdk.version && inputs.piSdk.version !== manifest.piSdk.version)) {
			console.log("pi-web-ui build inputs are unavailable or stale; cache disabled for this build");
			return null;
		}
		return inputs;
	} catch (error) {
		console.log(`pi-web-ui build inputs could not be read; cache disabled: ${error.message}`);
		return null;
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
