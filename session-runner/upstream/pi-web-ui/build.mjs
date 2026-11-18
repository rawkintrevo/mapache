#!/usr/bin/env node

import {createHash} from "node:crypto";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const PATCH_ROOT = join(HERE, "patches");

function fail(message) {
	throw new Error(`pi-web-ui build: ${message}`);
}

function readManifest(manifestPath = MANIFEST_PATH) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.schemaVersion !== 1) fail("unsupported manifest schema");
	if (!manifest.upstream?.commit || !manifest.upstream?.archiveUrl || !manifest.upstream?.archiveSha256) {
		fail("manifest is missing the upstream source pin");
	}
	if (!manifest.upstream.files || !manifest.patches?.length) fail("manifest is missing source hashes or patches");
	return manifest;
}

function sha256File(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Buffer(value) {
	return createHash("sha256").update(value).digest("hex");
}

function assertHash(label, actual, expected) {
	if (actual !== expected) fail(`${label} hash mismatch (expected ${expected}, got ${actual})`);
}

async function download(url, destination) {
	const response = await fetch(url);
	if (!response.ok) fail(`source download failed with HTTP ${response.status}`);
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
			rejectRun(new Error(`${command} ${args.join(" ")} failed (${signal || code})`));
		});
	});
}

async function verifyCommitMarker(sourceDir, expectedCommit) {
	const markerPath = join(sourceDir, ".mapache-source-commit");
	if (existsSync(markerPath)) {
		const marker = readFileSync(markerPath, "utf8").trim();
		if (marker !== expectedCommit) fail(`source revision mismatch (expected ${expectedCommit}, got ${marker})`);
		return;
	}
	if (existsSync(join(sourceDir, ".git"))) {
		let stdout = "";
		await new Promise((resolveRun, rejectRun) => {
			const child = spawn("git", ["rev-parse", "HEAD"], {cwd: sourceDir, stdio: ["ignore", "pipe", "pipe"]});
			let stderr = "";
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.on("error", rejectRun);
			child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr || `git rev-parse failed (${code})`)));
		});
		const revision = stdout.trim();
		if (revision !== expectedCommit) fail(`source revision mismatch (expected ${expectedCommit}, got ${revision})`);
		return;
	}
	fail("source revision cannot be verified; provide a checked-out commit or .mapache-source-commit");
}

function verifySourceFiles(sourceDir, manifest) {
	for (const [relativePath, expectedHash] of Object.entries(manifest.upstream.files)) {
		const filePath = join(sourceDir, relativePath);
		if (!existsSync(filePath)) fail(`pinned source file is missing: ${relativePath}`);
		assertHash(relativePath, sha256File(filePath), expectedHash);
	}
	const packageJson = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
	if (packageJson.version !== manifest.upstream.packageVersion) {
		fail(`upstream package version mismatch (expected ${manifest.upstream.packageVersion}, got ${packageJson.version})`);
	}
}

export async function applyPatches(sourceDir, manifest, patchRoot = PATCH_ROOT) {
	for (const relativePatch of manifest.patches) {
		const patchPath = join(patchRoot, relativePatch.replace(/^patches\//, ""));
		if (!existsSync(patchPath)) fail(`patch is missing: ${relativePatch}`);
		try {
			await run("git", ["apply", "--check", "--recount", "--whitespace=nowarn", patchPath], {cwd: sourceDir, stdio: "pipe"});
			await run("git", ["apply", "--recount", "--whitespace=nowarn", patchPath], {cwd: sourceDir, stdio: "pipe"});
		} catch (error) {
			fail(`patch baseline rejected for ${relativePatch}: ${error.message}`);
		}
	}
}

function writeBuildInfo(sourceDir, manifest) {
	const info = {
		schemaVersion: 1,
		upstreamCommit: manifest.upstream.commit,
		packageVersion: manifest.upstream.packageVersion,
		piSdkVersion: manifest.piSdk.version,
		piMcpAdapterVersion: manifest.piMcpAdapter.version,
	};
	writeFileSync(join(sourceDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

function copyRuntime(sourceDir, outputDir) {
	if (existsSync(outputDir) && readdirSync(outputDir).length > 0) fail(`output directory is not empty: ${outputDir}`);
	mkdirSync(outputDir, {recursive: true});
	const entries = [
		"package.json",
		"package-lock.json",
		"LICENSE",
		"build-info.json",
		"bin",
		"dist",
		"web/dist",
		"web/public",
		"themes",
		"extensions",
		"plugins/catalog.json",
		"node_modules",
	];
	for (const relativePath of entries) {
		const sourcePath = join(sourceDir, relativePath);
		if (!existsSync(sourcePath)) fail(`runtime output is missing: ${relativePath}`);
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
		else fail(`unknown option: ${arg}`);
	}
	if (!options.verifyOnly && !options.outputDir) fail("--output-dir is required unless --verify-only is used");
	return options;
}

export async function buildUpstream(options = {}) {
	const manifest = readManifest(options.manifestPath || MANIFEST_PATH);
	const workDir = options.workDir ? resolve(options.workDir) : mkdtempSync(join(tmpdir(), "mapache-pi-web-ui-"));
	const sourceDir = options.sourceDir ? resolve(options.sourceDir) : join(workDir, "source");
	const sourceArchive = join(workDir, "source.tar.gz");
	let ownsWorkDir = !options.workDir;
	try {
		mkdirSync(workDir, {recursive: true});
		if (options.sourceDir) {
			await verifyCommitMarker(sourceDir, manifest.upstream.commit);
		} else {
			mkdirSync(sourceDir, {recursive: true});
			const body = await download(manifest.upstream.archiveUrl, sourceArchive);
			assertHash("source archive", sha256Buffer(body), manifest.upstream.archiveSha256);
			await run("tar", ["-xzf", sourceArchive, "-C", sourceDir, "--strip-components=1"], {stdio: "pipe"});
			writeFileSync(join(sourceDir, ".mapache-source-commit"), `${manifest.upstream.commit}\n`, "utf8");
		}
		verifySourceFiles(sourceDir, manifest);
		await applyPatches(sourceDir, manifest);
		writeBuildInfo(sourceDir, manifest);
		if (options.verifyOnly) {
			return {commit: manifest.upstream.commit, packageVersion: manifest.upstream.packageVersion, piSdkVersion: manifest.piSdk.version, piMcpAdapterVersion: manifest.piMcpAdapter.version};
		}
		await run("npm", ["ci"], {cwd: sourceDir});
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
		copyRuntime(sourceDir, outputDir);
		return {commit: manifest.upstream.commit, packageVersion: manifest.upstream.packageVersion, piSdkVersion: manifest.piSdk.version, piMcpAdapterVersion: manifest.piMcpAdapter.version, outputDir};
	} finally {
		if (ownsWorkDir) rmSync(workDir, {recursive: true, force: true});
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	buildUpstream(parseArgs(process.argv.slice(2)))
		.then((result) => console.log(JSON.stringify({ok: true, ...result})))
		.catch((error) => {
			console.error(`✗ ${error.message}`);
			process.exitCode = 1;
		});
}
