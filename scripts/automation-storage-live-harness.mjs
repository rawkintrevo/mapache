import {mkdir, readFile, writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";

const execFile = promisify(execFileCallback);
export const PROJECT_ID = "pi-agents-cloud";
export const DEFAULT_REGION = "us-central1";
export const DEFAULT_SERVICE_ACCOUNT = "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com";
export const RETENTION_SECONDS = 604800;
const FIXTURE_PATH = new URL("../e2e/automation-storage/fixture-server.mjs", import.meta.url);

export function parseArgs(argv = []) {
  const values = {command: argv[0] || "run"};
  const rest = argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (argv[0] && !argv[0].startsWith("--") && argv[0] !== "run") throw new Error("command must be run");
  for (let index = 0; index < rest.length; index += 1) {
    const argument = String(rest[index] || "");
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    if (key === "keep") {
      values.keep = true;
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : rest[++index];
    if (!key || value === undefined || String(value).startsWith("--")) throw new Error(`missing value for --${key}`);
    if (!["artifact-dir", "bucket", "image", "project", "region", "service-account", "storage-rate-usd-per-gib-month"].includes(key)) {
      throw new Error(`unsupported option: --${key}`);
    }
    values[key] = String(value);
  }
  if (values.project !== PROJECT_ID) throw new Error(`project must be ${PROJECT_ID}`);
  if (values["storage-rate-usd-per-gib-month"] !== undefined) {
    const rate = Number(values["storage-rate-usd-per-gib-month"]);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("--storage-rate-usd-per-gib-month must be positive");
  }
  return values;
}

export async function runCommand(argv, dependencies = {}) {
  const args = parseArgs(argv);
  const runId = `storage-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const artifactDir = path.resolve(args["artifact-dir"] || path.join("artifacts", "automation-storage", runId));
  await mkdir(artifactDir, {recursive: true});
  const log = [];
  const run = dependencies.run || runGcloud;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const bucketName = args.bucket || `mapache-storage-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const region = args.region || DEFAULT_REGION;
  const serviceAccount = args["service-account"] || DEFAULT_SERVICE_ACCOUNT;
  const image = args.image || `us-central1-docker.pkg.dev/${PROJECT_ID}/pi-agents/session-runner:pi-chrome`;
  const services = [`mapache-storage-${runId}-a`, `mapache-storage-${runId}-b`];
  const generation = "fixture-generation";
  const checks = [];
  const retention = {seconds: RETENTION_SECONDS, billedBytes: null, estimatedUsd: null};
  let cleanup = {performed: false, retainedSoftDeleteSeconds: RETENTION_SECONDS};
  let token = "";

  async function step(name, operation) {
    const startedAt = new Date().toISOString();
    try {
      const result = await operation();
      log.push({name, startedAt, ok: true});
      return result;
    } catch (error) {
      log.push({name, startedAt, ok: false, error: sanitize(String(error.message || error))});
      throw error;
    }
  }

  async function gcloud(argsForCommand, options = {}) {
    return run([...(options.globalArgs || []), ...argsForCommand], {log, redact: options.redact});
  }

  async function request(serviceUrl, action, query = {}) {
    const params = new URLSearchParams({action, ...query});
    const response = await fetchImpl(`${serviceUrl}/fixture?${params}`, {headers: {authorization: `Bearer ${token}`} });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(`${action} failed: ${body.error || response.status}`);
    return body;
  }

  async function deployService(serviceName, fixtureB64, runnerId) {
    const command = "echo \"$MAPACHE_FIXTURE_SCRIPT_B64\" | base64 -d > /tmp/mapache-fixture.mjs && exec node /tmp/mapache-fixture.mjs";
    await gcloud([
      "run", "deploy", serviceName,
      `--project=${PROJECT_ID}`,
      `--region=${region}`,
      "--platform=managed",
      `--image=${image}`,
      `--service-account=${serviceAccount}`,
      "--execution-environment=gen2",
      "--no-allow-unauthenticated",
      "--port=8080",
      "--min=0",
      "--max=1",
      "--memory=1Gi",
      "--cpu=1",
      "--command=bash",
      `--args=-ceu,${command}`,
      `--set-env-vars=MAPACHE_FIXTURE_SCRIPT_B64=${fixtureB64},MAPACHE_FIXTURE_RUNNER_ID=${runnerId},WORKSPACE_STORAGE_MODE=shared-gcsfuse-v1,WORKSPACE_STORAGE_GENERATION=${generation},WORKSPACE_DIR=/workspace,PORT=8080`,
      `--add-volume=name=workspace,type=cloud-storage,bucket=${bucketName},mount-options=only-dir=trees/${generation},metadata-cache-ttl-secs=0,stat-cache-max-size-mb=0,type-cache-max-size-mb=0,implicit-dirs=true,log-severity=warning`,
      "--add-volume-mount=volume=workspace,mount-path=/workspace",
    ], {redact: [fixtureB64]});
    const {stdout} = await gcloud(["run", "services", "describe", serviceName, `--project=${PROJECT_ID}`, `--region=${region}`, "--format=value(status.url)"]);
    const serviceUrl = stdout.trim();
    if (!/^https:\/\//.test(serviceUrl)) throw new Error(`Cloud Run did not return a service URL for ${serviceName}`);
    return serviceUrl;
  }

  async function waitForService(serviceUrl) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        return await request(serviceUrl, "health");
      } catch (error) {
        if (attempt === 29) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async function check(name, condition, details = {}) {
    const result = {name, ok: Boolean(condition), ...details};
    checks.push(result);
    if (!result.ok) throw new Error(`check failed: ${name}`);
    return result;
  }

  let result;
  try {
    const fixtureB64 = Buffer.from(await readFile(FIXTURE_PATH)).toString("base64");
    await step("create-bucket", () => gcloud([
      "storage", "buckets", "create", `gs://${bucketName}`,
      `--project=${PROJECT_ID}`, `--location=${region}`, "--uniform-bucket-level-access",
      "--enable-hierarchical-namespace",
    ]));
    await step("configure-retention", () => gcloud([
      "storage", "buckets", "update", `gs://${bucketName}`,
      `--project=${PROJECT_ID}`, `--soft-delete-duration=${RETENTION_SECONDS}s`, "--no-versioning",
    ]));
    await step("grant-runner-object-access", () => gcloud([
      "storage", "buckets", "add-iam-policy-binding", `gs://${bucketName}`,
      `--project=${PROJECT_ID}`, `--member=serviceAccount:${serviceAccount}`, "--role=roles/storage.objectUser",
    ]));
    const markerFile = path.join(artifactDir, "workspace-ready.json");
    await writeFile(markerFile, `${JSON.stringify({state: "ready", storageGeneration: generation, operationId: runId})}\n`);
    await step("seed-generation-marker", () => gcloud([
      "storage", "cp", markerFile, `gs://${bucketName}/trees/${generation}/.mapache-internal/workspace-ready.json`,
      `--project=${PROJECT_ID}`,
    ]));
    const metadata = await step("inspect-bucket-contract", async () => {
      const described = await gcloud(["storage", "buckets", "describe", `gs://${bucketName}`, `--project=${PROJECT_ID}`, "--format=json"]);
      const parsed = JSON.parse(described.stdout);
      retention.observed = {
        softDeleteSeconds: Number(parsed.softDeletePolicy?.retentionDurationSeconds || 0),
        versioningEnabled: parsed.versioning?.enabled === true,
        hierarchicalNamespace: parsed.hierarchicalNamespace?.enabled === true,
      };
      await check("seven-day soft-delete policy", retention.observed.softDeleteSeconds === RETENTION_SECONDS, retention.observed);
      await check("Object Versioning disabled", retention.observed.versioningEnabled === false);
      await check("hierarchical namespace enabled", retention.observed.hierarchicalNamespace === true);
      return parsed;
    });
    token = (await gcloud(["auth", "print-identity-token"])).stdout.trim();
    const serviceUrls = [];
    for (let index = 0; index < services.length; index += 1) {
      const serviceUrl = await step(`deploy-runner-${index + 1}`, () => deployService(services[index], fixtureB64, `runner-${index + 1}`));
      serviceUrls.push(serviceUrl);
      await step(`wait-runner-${index + 1}`, () => waitForService(serviceUrl));
    }
    const [runnerA, runnerB] = serviceUrls;
    await step("cross-runner-create-and-reopen", async () => {
      await request(runnerA, "write", {path: "shared/cross-run.txt", content: "created by runner-a\n"});
      const reopened = await request(runnerB, "read", {path: "shared/cross-run.txt"});
      await check("shared file visible after close/reopen", reopened.content === "created by runner-a\n", {withinSeconds: 5});
    });
    await step("overwrite-delete-and-rename", async () => {
      await request(runnerB, "overwrite", {path: "shared/cross-run.txt", content: "overwritten by runner-b\n"});
      const refreshed = await request(runnerA, "read", {path: "shared/cross-run.txt"});
      await check("overwrite visible across runners", refreshed.content === "overwritten by runner-b\n");
      await request(runnerA, "rename", {path: "shared/cross-run.txt", target: "shared/renamed.txt"});
      await request(runnerB, "delete", {path: "shared/renamed.txt"});
    });
    const symlink = await step("symlink-fixture", () => request(runnerA, "symlink"));
    await check("supported symlink fixture", symlink.supported === true, symlink);
    await step("git-compatibility", async () => {
      const [gitA, gitB] = await Promise.all([request(runnerA, "git"), request(runnerB, "git")]);
      await check("runner A Git worktree", gitA.insideWorkTree === true, {status: gitA.status});
      await check("runner B Git worktree", gitB.insideWorkTree === true, {status: gitB.status});
      await check("private Git metadata stays outside mount", gitA.workspaceGitEntry === false && gitB.workspaceGitEntry === false);
    });
    await step("package-and-script-fixture", async () => {
      const [packageA, packageB] = await Promise.all([request(runnerA, "package"), request(runnerB, "package")]);
      await check("runner A package script", packageA.ok === true);
      await check("runner B package script", packageB.ok === true);
    });
    await step("same-file-concurrent-write", async () => {
      const concurrent = await Promise.all([
        request(runnerA, "concurrent", {path: "shared/concurrent.txt", content: "a\n"}).catch((error) => ({ok: false, error: sanitize(error.message)})),
        request(runnerB, "concurrent", {path: "shared/concurrent.txt", content: "b\n"}).catch((error) => ({ok: false, error: sanitize(error.message)})),
      ]);
      const final = await request(runnerA, "read", {path: "shared/concurrent.txt"});
      await check("concurrent-write outcome recorded", concurrent.some((item) => item.ok === true) && ["a\n", "b\n"].includes(final.content), {outcomes: concurrent, final: final.content});
    });
    const snapshot = await step("private-state-and-directory-fixture", () => request(runnerA, "snapshot"));
    await check("Mapache private state stays outside mount", snapshot.privateStateOutsideMount === true);
    const anonymous = await fetchImpl(`https://storage.googleapis.com/${bucketName}/trees/${generation}/shared/concurrent.txt`);
    await check("anonymous bucket read denied", anonymous.status === 401 || anonymous.status === 403, {status: anonymous.status});
    retention.billedBytes = snapshot.tree.reduce((total, entry) => total + Number(entry.size || 0), 0);
    const rate = Number(args["storage-rate-usd-per-gib-month"] || 0);
    retention.estimatedUsd = rate ? retention.billedBytes / (1024 ** 3) * rate * (RETENTION_SECONDS / (30 * 24 * 60 * 60)) : null;
    result = {ok: checks.every((item) => item.ok), runId, bucketName, services: serviceUrls, retention, checks, metadata, artifacts: artifactDir};
  } catch (error) {
    result = {ok: false, runId, bucketName, services, retention, checks, error: sanitize(error.message || error), artifacts: artifactDir};
  } finally {
    if (!args.keep) {
      for (const service of services) {
        await gcloud(["run", "services", "delete", service, `--project=${PROJECT_ID}`, `--region=${region}`, "--quiet"]).catch(() => {});
      }
      await gcloud(["storage", "buckets", "delete", `gs://${bucketName}`, `--project=${PROJECT_ID}`, "--quiet"]).catch(() => {});
      cleanup = {performed: true, retainedSoftDeleteSeconds: RETENTION_SECONDS};
    } else cleanup = {performed: false, retainedSoftDeleteSeconds: RETENTION_SECONDS, reason: "--keep supplied"};
    if (result) result.cleanup = cleanup;
    await writeFile(path.join(artifactDir, "checks.json"), `${JSON.stringify({result, log}, null, 2)}\n`);
  }
  return result;
}

async function runGcloud(args, {log = [], redact = []} = {}) {
  const safeArgs = args.map((arg) => redact.some((value) => String(arg).includes(value)) ? "[redacted]" : String(arg));
  log.push({command: "gcloud", args: safeArgs});
  const result = await execFile("gcloud", args, {encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
  return {stdout: result.stdout, stderr: result.stderr};
}

function sanitize(value) {
  return String(value || "")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/ya29\.[A-Za-z0-9._-]+/g, "[redacted-token]")
      .slice(0, 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result?.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${sanitize(error.message || error)}\n`);
    process.exitCode = 1;
  });
}
