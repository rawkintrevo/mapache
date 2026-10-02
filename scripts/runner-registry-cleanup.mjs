import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {isDeepStrictEqual} from "node:util";

const PROJECT = "pi-agents-cloud";
const LOCATION = "us-central1";
const REPOSITORY = "pi-agents";
const REGISTRY = `${LOCATION}-docker.pkg.dev/${PROJECT}/${REPOSITORY}`;
const RUNNER = `${REGISTRY}/session-runner`;
const VARIANTS = ["default", "pi-basic", "pi-web", "pi-chrome", "codex-basic", "codex-web", "codex-chrome", "pi-n64"];
const POLICY_NAMES = ["runner-pr-2-days", "runner-revision-7-days", "keep-deployed-and-other-tags"];

export function classifyTag(tag) {
  for (const variant of VARIANTS) {
    // Older CI accidentally repeated the variant; include those historical builds.
    for (const prefix of [`${variant}-`, `${variant}-${variant}-`]) {
      if (!tag.startsWith(prefix)) continue;
      const suffix = tag.slice(prefix.length);
      if (/^pr-\d+-[a-f0-9]{7,40}$/.test(suffix)) return "pr";
      if (/^[a-f0-9]{7,40}$/.test(suffix)) return "revision";
    }
  }
  return "other";
}

export function buildPlan({images, revisions = [], services = [], jobs = [], now = Date.now()}) {
  const protectedVersions = new Set();
  const deployedVersions = new Set();
  const byReference = new Map();
  for (const image of images) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image.version)) throw new Error("Invalid image digest");
    byReference.set(`${image.package}@${image.version}`, image);
    for (const tag of image.tags || []) byReference.set(`${image.package}:${tag}`, image);
    if (image.package === RUNNER && (image.tags || []).some((tag) => classifyTag(tag) === "other")) {
      protectedVersions.add(image.version);
    }
  }
  function protect(reference) {
    if (!reference?.startsWith(`${REGISTRY}/`)) return;
    const image = byReference.get(reference);
    if (!image) throw new Error(`Deployed image cannot be resolved in the inventory: ${reference}`);
    protectedVersions.add(image.version);
    deployedVersions.add(image.version);
  }
  for (const revision of revisions) {
    protect(revision.status?.imageDigest);
    for (const container of revision.spec?.containers || []) protect(container.image);
  }
  for (const service of services) {
    for (const container of service.spec?.template?.spec?.containers || []) protect(container.image);
  }
  for (const job of jobs) {
    for (const container of job.spec?.template?.spec?.template?.spec?.containers || []) protect(container.image);
  }
  const tags = {pr: new Set(), revision: new Set()};
  for (const image of images.filter((item) => item.package === RUNNER)) {
    for (const tag of image.tags || []) {
      const kind = classifyTag(tag);
      if (kind !== "other") tags[kind].add(tag);
    }
  }
  // Full inventoried tags avoid treating arbitrary variant-prefixed QA tags as releases.
  // New tags become eligible only after another successful inventory/refresh.
  const policies = [
    {name: POLICY_NAMES[0], action: {type: "Delete"}, condition: {
      tagState: "tagged", packageNamePrefixes: ["session-runner"],
      tagPrefixes: [...tags.pr].map((tag) => tag.slice(0, 64)).sort(), olderThan: "172800s",
    }},
    {name: POLICY_NAMES[1], action: {type: "Delete"}, condition: {
      tagState: "tagged", packageNamePrefixes: ["session-runner"],
      tagPrefixes: [...tags.revision].map((tag) => tag.slice(0, 64)).sort(), olderThan: "604800s",
    }},
    {name: POLICY_NAMES[2], action: {type: "Keep"}, condition: {
      // Artifact Registry limits prefixes to 64 characters, including "sha256:".
      tagState: "any", versionNamePrefixes: [...new Set([...protectedVersions].map((version) => version.slice(0, 64)))].sort(),
    }},
  ];
  // Empty prefix arrays mean unconstrained conditions, not "match nothing".
  // Keep stable policy IDs but turn an exhausted category into a harmless keep
  // rule; cleanup can legitimately remove every PR image between builds.
  for (let index = 0; index < 2; index++) {
    if (!policies[index].condition.tagPrefixes.length) {
      policies[index] = {name: POLICY_NAMES[index], action: {type: "Keep"},
        condition: {tagState: "untagged", packageNamePrefixes: ["session-runner"]}};
    }
  }
  if (!images.length || !protectedVersions.size) {
    throw new Error("Incomplete inventory: refusing to emit an unconstrained cleanup policy");
  }
  const candidates = [];
  for (const image of images) {
    if (policies[2].condition.versionNamePrefixes.some((prefix) => image.version.startsWith(prefix))) continue;
    const created = Date.parse(image.createTime);
    if (!Number.isFinite(created)) throw new Error("Invalid image creation time");
    const matchingRules = policies.filter((policy) => policy.action.type === "Delete" &&
      policy.condition.packageNamePrefixes.some((prefix) => image.package.slice(REGISTRY.length + 1).startsWith(prefix)) &&
      (image.tags || []).some((tag) => policy.condition.tagPrefixes.some((prefix) => tag.startsWith(prefix))));
    // Native tag/package matching uses prefixes. Refuse collateral matches entirely.
    if (matchingRules.length && (image.package !== RUNNER || (image.tags || []).some((tag) => classifyTag(tag) === "other"))) {
      throw new Error(`Unexpected prefix match: ${image.package}@${image.version}`);
    }
    const matches = matchingRules.filter((policy) => now - created > Number.parseInt(policy.condition.olderThan, 10) * 1000);
    if (matches.length) candidates.push({digest: image.version, tags: image.tags, rules: matches.map((p) => p.name)});
  }
  return {policies, summary: {
    images: images.length, untaggedImages: images.filter((i) => !i.tags?.length).length,
    deployedDigests: deployedVersions.size, protectedDigests: protectedVersions.size,
    eligibleImages: candidates.length,
  }, candidates};
}

function gcloud(args, json = true) {
  const output = execFileSync("gcloud", [...args, "--project", PROJECT, ...(json ? ["--format=json"] : [])], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"],
  });
  return json ? JSON.parse(output) : output;
}

export function run({mode, project}) {
  if (project !== PROJECT || !["plan", "dry-run", "apply"].includes(mode)) {
    throw new Error("Usage: node scripts/runner-registry-cleanup.mjs --project=pi-agents-cloud --mode=plan|dry-run|apply");
  }
  const repository = gcloud(["artifacts", "repositories", "describe", REPOSITORY, "--location", LOCATION]);
  if (Object.keys(repository.cleanupPolicies || {}).some((name) => !POLICY_NAMES.includes(name))) {
    throw new Error("Unknown existing cleanup policies: review before replacing them");
  }
  const services = gcloud(["run", "services", "list"]);
  const jobs = gcloud(["run", "jobs", "list"]);
  const regions = new Set(services.map((service) => service.metadata?.labels?.["cloud.googleapis.com/location"]));
  if (regions.has(undefined)) throw new Error("Service inventory contains an unknown region");
  const revisions = [...regions].flatMap((region) => gcloud(["run", "revisions", "list", "--region", region]));
  const images = gcloud(["artifacts", "docker", "images", "list", REGISTRY, "--include-tags"]);
  const plan = buildPlan({images, revisions, services, jobs});
  console.log(JSON.stringify({mode, ...plan}, null, 2));
  if (mode === "plan") return;
  const directory = mkdtempSync(join(tmpdir(), "mapache-registry-cleanup-"));
  try {
    const policyFile = join(directory, "policy.json");
    writeFileSync(policyFile, JSON.stringify(plan.policies));
    gcloud(["artifacts", "repositories", "set-cleanup-policies", REPOSITORY,
      "--location", LOCATION, "--policy", policyFile, mode === "apply" ? "--no-dry-run" : "--dry-run"], false);
    const actual = gcloud(["artifacts", "repositories", "describe", REPOSITORY, "--location", LOCATION]);
    if (Boolean(actual.cleanupPolicyDryRun) !== (mode === "dry-run")) throw new Error("Cleanup mode verification failed");
    for (const policy of plan.policies) {
      const saved = actual.cleanupPolicies?.[policy.name];
      if (!saved || saved.action !== policy.action.type.toUpperCase() ||
          !isDeepStrictEqual({...saved.condition, tagState: saved.condition.tagState.toLowerCase()}, policy.condition)) {
        throw new Error(`Cleanup policy verification failed: ${policy.name}`);
      }
    }
    console.error(`Verified ${mode} policies for ${PROJECT}/${REPOSITORY}`);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
  run({mode: options.mode || "plan", project: options.project});
}
