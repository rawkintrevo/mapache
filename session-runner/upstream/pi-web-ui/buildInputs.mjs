#!/usr/bin/env node

import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolveLatestPackage, resolveStableRelease} from "./releaseResolver.mjs";
import {CACHE_SCHEMA_VERSION, cacheIdentitySha256, sha256Buffer, sha256File} from "./artifactCache.mjs";
import {applyPatches} from "./build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = join(HERE, "../../pi-web-ui-build-inputs.json");

function fail(message) {
	throw new Error(`pi-web-ui build inputs: ${message}`);
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env || process.env,
			stdio: options.capture ? ["ignore", "pipe", "pipe"] : options.stdio || "inherit",
		});
		let stdout = "";
		let stderr = "";
		if (options.capture) {
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
		}
		child.on("error", rejectRun);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolveRun({stdout, stderr});
				return;
			}
			rejectRun(new Error(`${command} ${args.join(" ")} failed (${signal || code})${stderr ? `: ${stderr.trim()}` : ""}`));
		});
	});
}

function readManifest(manifestPath) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.schemaVersion !== 2) fail("unsupported manifest schema");
	if (!manifest.upstream?.repository || manifest.upstream.releaseChannel !== "stable" ||
		!manifest.upstream.releaseApiUrl || !manifest.upstream.commitApiUrl?.includes("{tag}")) {
		fail("manifest must resolve the stable upstream release at build time");
	}
	if (!manifest.piSdk?.package || manifest.piSdk.releaseChannel !== "latest") {
		fail("manifest must resolve the embedded Pi SDK from the latest npm channel");
	}
	if (!manifest.patches?.length || !manifest.build?.runtimeEntries?.length) {
		fail("manifest is missing patches or runtime entries");
	}
	return manifest;
}

async function download(url, destination, fetchImpl = globalThis.fetch) {
	let response;
	try {
		response = await fetchImpl(url, {headers: {"user-agent": "mapache-pi-web-ui-builder"}});
	} catch (error) {
		fail(`source download failed: ${error?.message || error}`);
	}
	if (!response?.ok) fail(`source download failed with HTTP ${response?.status ?? "unknown"}`);
	const body = Buffer.from(await response.arrayBuffer());
	writeFileSync(destination, body);
	return body;
}

function sourceFiles(sourceDir, manifest, release) {
	const hashes = {};
	for (const relativePath of manifest.upstream.requiredFiles) {
		if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
			fail(`invalid required source path: ${relativePath}`);
		}
		const filePath = join(sourceDir, relativePath);
		if (!existsSync(filePath)) fail(`required upstream source file is missing: ${relativePath}`);
		hashes[relativePath] = sha256File(filePath);
	}
	const packageJson = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
	if (packageJson.name !== manifest.upstream.packageName) {
		fail(`upstream package name mismatch (expected ${manifest.upstream.packageName}, got ${packageJson.name})`);
	}
	if (packageJson.version !== release.version) {
		fail(`upstream package version mismatch (expected ${release.version}, got ${packageJson.version})`);
	}
	return hashes;
}

function packageLock(sourceDir) {
	const lockPath = join(sourceDir, "package-lock.json");
	if (!existsSync(lockPath)) fail("upstream package-lock.json is missing");
	return JSON.parse(readFileSync(lockPath, "utf8"));
}

function findLockedPackage(lock, packageName) {
	const packages = lock?.packages || {};
	const candidates = Object.entries(packages)
		.filter(([path, value]) => value?.name === packageName || path === `node_modules/${packageName}`)
		.sort(([left], [right]) => left.length - right.length);
	if (!candidates.length) fail(`resolved dependency tree is missing ${packageName}`);
	const [path, value] = candidates[0];
	return {
		path,
		package: packageName,
		version: value.version,
		integrity: value.integrity || null,
		resolved: value.resolved || null,
	};
}

async function npmVersion() {
	const result = await run("npm", ["--version"], {capture: true});
	return result.stdout.trim();
}

async function gitVersion() {
	const result = await run("git", ["--version"], {capture: true});
	return result.stdout.trim();
}

function fileDescriptor(relativePath, absolutePath) {
	if (!existsSync(absolutePath)) fail(`builder input is missing: ${relativePath}`);
	return {path: relativePath, sha256: sha256File(absolutePath)};
}

function stableRelease(release, archiveSha256, sourceFileHashes) {
	return {
		repository: release.repository,
		channel: release.channel,
		tag: release.tag,
		version: release.version,
		commit: release.commit,
		releaseId: release.releaseId ?? null,
		archiveUrl: release.archiveUrl,
		archiveSha256,
		publishedAt: release.publishedAt || null,
		sourceFiles: sourceFileHashes,
	};
}

function stableSdk(sdk) {
	return {
		package: sdk.package,
		version: sdk.version,
		integrity: sdk.integrity,
		tarball: sdk.tarball || null,
		registryUrl: sdk.registryUrl,
	};
}

export function createBuildIdentity({manifest, release, sdk, piAi, dependencyTree, patches, builderFiles, environment}) {
	return {
		cacheSchemaVersion: CACHE_SCHEMA_VERSION,
		upstream: stableRelease(release, release.archiveSha256, release.sourceFiles),
		dependencyTree,
		piSdk: stableSdk(sdk),
		piAi: {
			package: piAi.package,
			version: piAi.version,
			integrity: piAi.integrity || null,
			resolved: piAi.resolved || null,
		},
		piMcpAdapter: {
			package: manifest.piMcpAdapter.package,
			version: manifest.piMcpAdapter.version,
			integrity: manifest.piMcpAdapter.integrity,
			peerCompatibility: manifest.piMcpAdapter.peerCompatibility || {},
		},
		patches,
		builderFiles,
		buildEnvironment: environment,
		buildOptions: {
			commands: manifest.build.commands,
			nodeMajor: manifest.build.nodeMajor,
			webBasePath: manifest.build.webBasePath,
			adapterInspection: true,
			skipTests: false,
		},
	};
}

export async function resolveBuildInputs({
	manifestPath = join(HERE, "manifest.json"),
	workDir,
	fetchImpl = globalThis.fetch,
	patchRoot = join(HERE, "patches"),
	now = new Date().toISOString(),
} = {}) {
	const manifest = readManifest(manifestPath);
	const ownedWorkDir = !workDir;
	const workspace = resolve(workDir || mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-inputs-")));
	const sourceDir = join(workspace, "source");
	try {
		mkdirSync(sourceDir, {recursive: true});
		const release = await resolveStableRelease({manifest, fetchImpl, now});
		const sourceArchive = join(workspace, "source.tar.gz");
		const sourceBody = await download(release.archiveUrl, sourceArchive, fetchImpl);
		const archiveSha256 = sha256Buffer(sourceBody);
		await run("tar", ["-xzf", sourceArchive, "-C", sourceDir, "--strip-components=1"], {stdio: "pipe"});
		const sourceFileHashes = sourceFiles(sourceDir, manifest, release);
		writeFileSync(join(sourceDir, ".mapache-source-commit"), `${JSON.stringify({
			tag: release.tag,
			commit: release.commit,
			packageVersion: release.version,
		})}\n`, "utf8");
		await applyPatches(sourceDir, manifest, patchRoot);
		const resolvedRelease = {...release, archiveSha256, sourceFiles: sourceFileHashes, resolvedAt: now};
		const sdk = await resolveLatestPackage({packageName: manifest.piSdk.package, fetchImpl, now});
		await run("npm", [
			"install",
			"--package-lock-only",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--package-lock=true",
			`${sdk.package}@${sdk.version}`,
		], {cwd: sourceDir});
		const lock = packageLock(sourceDir);
		const piAi = findLockedPackage(lock, "@earendil-works/pi-ai");
		const dependencyTree = {
			lockfileVersion: lock.lockfileVersion,
			name: lock.name || manifest.upstream.packageName,
			packages: lock.packages || {},
			dependencies: lock.dependencies || {},
		};
		const patchDescriptors = manifest.patches.map((relativePatch) => {
			const patchPath = join(patchRoot, relativePatch.replace(/^patches\//, ""));
			return fileDescriptor(relativePatch, patchPath);
		});
		const builderFiles = [
			fileDescriptor("upstream/pi-web-ui/build.mjs", join(HERE, "build.mjs")),
			fileDescriptor("upstream/pi-web-ui/buildInputs.mjs", join(HERE, "buildInputs.mjs")),
			fileDescriptor("upstream/pi-web-ui/releaseResolver.mjs", join(HERE, "releaseResolver.mjs")),
			fileDescriptor("upstream/pi-web-ui/artifactCache.mjs", join(HERE, "artifactCache.mjs")),
			fileDescriptor("upstream/pi-web-ui/manifest.json", join(HERE, "manifest.json")),
			fileDescriptor("lib/patchPiMcpAdapter.js", join(HERE, "../../lib/patchPiMcpAdapter.js")),
			fileDescriptor("lib/patchPiModelCatalog.js", join(HERE, "../../lib/patchPiModelCatalog.js")),
			fileDescriptor("lib/piModelCatalogOverrides.json", join(HERE, "../../lib/piModelCatalogOverrides.json")),
			fileDescriptor("Dockerfile.gcp-runner", join(HERE, "../../Dockerfile.gcp-runner")),
		];
		const identity = createBuildIdentity({
			manifest,
			release: resolvedRelease,
			sdk,
			piAi,
			dependencyTree,
			patches: patchDescriptors,
			builderFiles,
			environment: {
				node: process.version,
				npm: await npmVersion(),
				git: await gitVersion(),
				platform: process.platform,
				arch: process.arch,
				containerBase: `node:${manifest.build.nodeMajor}-bookworm-slim`,
				locale: "",
			},
		});
		const identitySha256 = cacheIdentitySha256(identity);
		return {
			schemaVersion: CACHE_SCHEMA_VERSION,
			cacheKey: identitySha256,
			identitySha256,
			identity,
			release: resolvedRelease,
			piSdk: sdk,
			piAi,
			resolvedAt: now,
		};
	} finally {
		if (ownedWorkDir) rmSync(workspace, {recursive: true, force: true});
	}
}

function parseArgs(argv) {
	const options = {outputPath: DEFAULT_OUTPUT, keyOutput: ""};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--output") options.outputPath = argv[++index] || fail("--output requires a path");
		else if (arg === "--key-output") options.keyOutput = argv[++index] || fail("--key-output requires a path");
		else if (arg === "--manifest") options.manifestPath = argv[++index] || fail("--manifest requires a path");
		else fail(`unknown option: ${arg}`);
	}
	return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const options = parseArgs(process.argv.slice(2));
	resolveBuildInputs(options)
		.then((inputs) => {
			mkdirSync(dirname(resolve(options.outputPath)), {recursive: true});
			writeFileSync(resolve(options.outputPath), `${JSON.stringify(inputs, null, 2)}\n`, "utf8");
			if (options.keyOutput) writeFileSync(resolve(options.keyOutput), `${inputs.cacheKey}\n`, "utf8");
			console.log(JSON.stringify({ok: true, cacheKey: inputs.cacheKey, identitySha256: inputs.identitySha256}));
		})
		.catch((error) => {
			console.error(`✗ ${error.message}`);
			process.exitCode = 1;
		});
}
