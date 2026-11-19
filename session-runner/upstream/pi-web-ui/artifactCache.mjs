#!/usr/bin/env node

import {createHash} from "node:crypto";
import {cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {spawn} from "node:child_process";

export const CACHE_SCHEMA_VERSION = 1;

function fail(message) {
	throw new Error(`pi-web-ui artifact cache: ${message}`);
}

export function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
	}
	return value;
}

export function sha256Buffer(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
	return sha256Buffer(readFileSync(filePath));
}

export function cacheIdentitySha256(identity) {
	return sha256Buffer(JSON.stringify(canonicalize(identity)));
}

export function cacheKey(identity) {
	return cacheIdentitySha256(identity);
}

export function directoryDigest(rootPath) {
	const root = resolve(rootPath);
	if (!existsSync(root) || !statSync(root).isDirectory()) fail(`runtime directory is missing: ${root}`);
	const entries = [];

	function visit(current, relativeRoot) {
		for (const name of readdirSync(current).sort()) {
			const absolutePath = join(current, name);
			const relativePath = relativeRoot ? `${relativeRoot}/${name}` : name;
			const entry = lstatSync(absolutePath);
			if (entry.isSymbolicLink()) fail(`runtime contains a symbolic link: ${relativePath}`);
			if (entry.isDirectory()) {
				entries.push({kind: "directory", mode: entry.mode & 0o7777, path: relativePath});
				visit(absolutePath, relativePath);
				continue;
			}
			if (!entry.isFile()) fail(`runtime contains an unsupported entry: ${relativePath}`);
			entries.push({
				kind: "file",
				mode: entry.mode & 0o7777,
				path: relativePath,
				sha256: sha256File(absolutePath),
				size: entry.size,
			});
		}
	}

	visit(root, "");
	return sha256Buffer(JSON.stringify(entries));
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

function safeArchiveEntry(entry) {
	const normalized = String(entry || "").replace(/\\/g, "/");
	if (!normalized || normalized === ".") return true;
	if (normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
	return normalized === "cache-manifest.json" || normalized === "runtime" || normalized.startsWith("runtime/");
}

async function extractArchive(archivePath, destination) {
	const listing = await run("tar", ["-tzf", archivePath], {capture: true});
	const entries = listing.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
	if (!entries.length || entries.some((entry) => !safeArchiveEntry(entry))) {
		fail("cache archive contains an unsafe or unexpected path");
	}
	const verbose = await run("tar", ["-tvzf", archivePath], {capture: true});
	if (verbose.stdout.split(/\r?\n/).some((line) => line && !["-", "d"].includes(line[0]))) {
		fail("cache archive contains a link or unsupported entry");
	}
	await run("tar", ["-xzf", archivePath, "-C", destination, "--no-same-owner", "--same-permissions"], {stdio: "pipe"});
}

function readJson(filePath, label) {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		fail(`${label} is not valid JSON: ${error.message}`);
	}
}

function assertRuntimeEntries(runtimeDir, requiredEntries = []) {
	for (const relativePath of requiredEntries) {
		if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
			fail(`invalid required runtime path: ${relativePath}`);
		}
		if (!existsSync(join(runtimeDir, relativePath))) fail(`runtime output is missing: ${relativePath}`);
	}
}

export async function packCacheArtifact({runtimeDir, outputPath, expectedKey, expectedIdentitySha256 = null} = {}) {
	const runtime = resolve(runtimeDir || "");
	const output = resolve(outputPath || "");
	if (!existsSync(runtime) || !statSync(runtime).isDirectory()) fail(`runtime directory is missing: ${runtime}`);
	const buildInfoPath = join(runtime, "build-info.json");
	if (!existsSync(buildInfoPath)) fail("runtime is missing build-info.json");
	const buildInfo = readJson(buildInfoPath, "build-info.json");
	if (!buildInfo.cacheKey || buildInfo.cacheKey !== expectedKey) {
		fail(`runtime cache key mismatch (expected ${expectedKey}, got ${buildInfo.cacheKey || "missing"})`);
	}
	if (expectedIdentitySha256 && buildInfo.cacheIdentitySha256 !== expectedIdentitySha256) {
		fail(`runtime cache identity mismatch (expected ${expectedIdentitySha256}, got ${buildInfo.cacheIdentitySha256 || "missing"})`);
	}
	const stage = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-cache-pack-"));
	try {
		const stagedRuntime = join(stage, "runtime");
		cpSync(runtime, stagedRuntime, {recursive: true, dereference: true});
		const manifest = {
			schemaVersion: CACHE_SCHEMA_VERSION,
			cacheKey: expectedKey,
			cacheIdentitySha256: buildInfo.cacheIdentitySha256 || null,
			buildInfoSha256: sha256File(join(stagedRuntime, "build-info.json")),
			runtimeDigest: directoryDigest(stagedRuntime),
		};
		writeFileSync(join(stage, "cache-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		mkdirSync(dirname(output), {recursive: true});
		await run("tar", [
			"-czf", output,
			"--sort=name",
			"--mtime=@0",
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"-C", stage,
			"cache-manifest.json",
			"runtime",
		], {stdio: "pipe"});
		return manifest;
	} finally {
		rmSync(stage, {recursive: true, force: true});
	}
}

export async function restoreCacheArtifact({
	archivePath,
	outputDir,
	expectedKey,
	expectedIdentitySha256 = null,
	requiredRuntimeEntries = [],
} = {}) {
	const startedAt = Date.now();
	const archive = resolve(archivePath || "");
	const output = resolve(outputDir || "");
	const miss = (reason) => ({status: "miss", reason, elapsedMs: Date.now() - startedAt});
	if (!archivePath || !existsSync(archive)) return miss("missing");
	try {
		if (statSync(archive).size === 0) return miss("missing");
	} catch (error) {
		return miss("missing");
	}
	const stage = mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-cache-restore-"));
	try {
		try {
			await extractArchive(archive, stage);
		} catch (error) {
			return miss(`unreadable:${error.message}`);
		}
		const manifestPath = join(stage, "cache-manifest.json");
		const runtime = join(stage, "runtime");
		if (!existsSync(manifestPath) || !existsSync(runtime)) return miss("manifest-or-runtime-missing");
		const manifest = readJson(manifestPath, "cache-manifest.json");
		if (manifest.schemaVersion !== CACHE_SCHEMA_VERSION) return miss("unsupported-schema");
		if (manifest.cacheKey !== expectedKey) return miss("cache-key-mismatch");
		if (expectedIdentitySha256 && manifest.cacheIdentitySha256 !== expectedIdentitySha256) return miss("cache-identity-mismatch");
		const buildInfoPath = join(runtime, "build-info.json");
		if (!existsSync(buildInfoPath)) return miss("build-info-missing");
		if (manifest.buildInfoSha256 !== sha256File(buildInfoPath)) return miss("build-info-checksum-mismatch");
		const buildInfo = readJson(buildInfoPath, "cached build-info.json");
		if (buildInfo.cacheKey !== expectedKey) return miss("build-info-key-mismatch");
		if (expectedIdentitySha256 && buildInfo.cacheIdentitySha256 !== expectedIdentitySha256) return miss("build-info-identity-mismatch");
		if (manifest.runtimeDigest !== directoryDigest(runtime)) return miss("runtime-checksum-mismatch");
		try {
			assertRuntimeEntries(runtime, requiredRuntimeEntries);
		} catch (error) {
			return miss(`runtime-invalid:${error.message}`);
		}
		if (existsSync(output) && readdirSync(output).length > 0) return miss("output-not-empty");
		mkdirSync(output, {recursive: true});
		cpSync(runtime, output, {recursive: true, dereference: true});
		return {status: "hit", reason: "verified", manifest, buildInfo, elapsedMs: Date.now() - startedAt};
	} catch (error) {
		return miss(`unverifiable:${error.message}`);
	} finally {
		rmSync(stage, {recursive: true, force: true});
	}
}

export function updateCacheDecision(runtimeDir, decision) {
	const buildInfoPath = join(resolve(runtimeDir), "build-info.json");
	if (!existsSync(buildInfoPath)) fail("runtime is missing build-info.json");
	const buildInfo = readJson(buildInfoPath, "build-info.json");
	buildInfo.cacheDecision = decision;
	writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
	return buildInfo;
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "pack") options.command = "pack";
		else if (arg === "--runtime-dir") options.runtimeDir = argv[++index] || fail("--runtime-dir requires a path");
		else if (arg === "--output") options.outputPath = argv[++index] || fail("--output requires a path");
		else if (arg === "--expected-key") options.expectedKey = argv[++index] || fail("--expected-key requires a value");
		else if (arg === "--expected-identity") options.expectedIdentitySha256 = argv[++index] || fail("--expected-identity requires a value");
		else fail(`unknown option: ${arg}`);
	}
	if (options.command !== "pack") fail("the command must be pack");
	if (!options.runtimeDir || !options.outputPath || !options.expectedKey) fail("pack requires --runtime-dir, --output, and --expected-key");
	return options;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
	packCacheArtifact(parseArgs(process.argv.slice(2)))
		.then((manifest) => console.log(JSON.stringify({ok: true, ...manifest})))
		.catch((error) => {
			console.error(`✗ ${error.message}`);
			process.exitCode = 1;
		});
}
