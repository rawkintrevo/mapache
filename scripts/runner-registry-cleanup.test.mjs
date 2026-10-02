import test from "node:test";
import assert from "node:assert/strict";
import {buildPlan, classifyTag, run} from "./runner-registry-cleanup.mjs";

const runner = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner";
const now = Date.parse("2026-10-02T12:00:00Z");
const digest = (id) => `sha256:${id.toString(16).padStart(8, "0").padEnd(64, "0")}`;
const image = (id, tags, days) => ({package: runner, version: digest(id), tags,
  createTime: new Date(now - days * 86400000).toISOString()});
const fixtures = () => [
  image(1, ["pi-chrome-pr-1-abcdef012345"], 3),
  image(2, [`pi-chrome-${"a".repeat(40)}`], 8),
  image(3, ["pi-chrome"], 90),
];

test("only recognized PR/revision tag formats enter deletion rules", () => {
  assert.equal(classifyTag("pi-chrome-pr-1-abcdef012345"), "pr");
  assert.equal(classifyTag("codex-basic-codex-basic-pr-278-abcdef012345"), "pr");
  assert.equal(classifyTag(`pi-web-pi-web-${"a".repeat(40)}`), "revision");
  for (const tag of ["pi-chrome", "latest", "pi-chrome-qa-fault-harness-1234567", "pi-chrome-deadbee-extra"]) {
    assert.equal(classifyTag(tag), "other");
  }
});

test("two-day PR and seven-day release boundaries; untagged and fixtures survive", () => {
  const images = [...fixtures(), image(4, [], 90), image(5, ["pi-chrome-pr-2-abcdef012345"], 2),
    image(6, [`pi-chrome-${"b".repeat(40)}`], 7),
    {...image(7, ["20260911"], 90), package: runner.replace("session-runner", "operation-ledger-outage-fixture")}];
  const plan = buildPlan({images, now});
  assert.deepEqual(plan.candidates.map((i) => i.digest), [digest(1), digest(2)]);
  assert.equal(plan.summary.untaggedImages, 1);
});

test("resolved deployment digests, service templates, and jobs override deletion", () => {
  const images = [...fixtures(), image(4, [`pi-chrome-${"c".repeat(40)}`], 90)];
  const plan = buildPlan({images, now,
    revisions: [{status: {imageDigest: `${runner}@${digest(1)}`}, spec: {containers: [{image: `${runner}:pi-chrome`}]}}],
    services: [{spec: {template: {spec: {containers: [{image: `${runner}@${digest(2)}`}]}}}}],
    jobs: [{spec: {template: {spec: {template: {spec: {containers: [{image: `${runner}@${digest(4)}`}]}}}}}}],
  });
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.summary.deployedDigests, 4);
});

test("a compatibility or custom tag on the same digest keeps the whole image", () => {
  const images = fixtures();
  images[0].tags.push("qa-canary");
  images[1].tags.push("pi-chrome");
  assert.equal(buildPlan({images, now}).candidates.length, 0);
});

test("fails closed on unresolved deployments, missing inventory, and package prefix collisions", () => {
  assert.throws(() => buildPlan({images: fixtures(), now, revisions: [{status: {imageDigest: `${runner}@${digest(99)}`}}]}), /cannot be resolved/);
  assert.throws(() => buildPlan({images: [], now}), /Incomplete inventory/);
  const collision = {...fixtures()[0], package: `${runner}-other`, version: digest(99)};
  assert.throws(() => buildPlan({images: [...fixtures(), collision], now}), /Unexpected prefix match/);
  collision.createTime = new Date(now).toISOString();
  assert.throws(() => buildPlan({images: [...fixtures(), collision], now}), /Unexpected prefix match/);
});

test("native 64-character prefix limits and conservative digest collisions", () => {
  const images = fixtures();
  images.push(image(4, [`codex-chrome-codex-chrome-${"a".repeat(40)}`], 90));
  images.push({...image(5, ["pi-chrome-pr-5-abcdef012345"], 90), version: `${digest(3).slice(0, -1)}f`});
  const plan = buildPlan({images, now});
  assert.equal(plan.candidates.length, 3);
  for (const policy of plan.policies) {
    for (const prefix of [...(policy.condition.tagPrefixes || []), ...(policy.condition.versionNamePrefixes || [])]) {
      assert.ok(prefix.length <= 64);
    }
  }
});

test("exhausted PR inventory never produces an unrestricted deletion rule", () => {
  const plan = buildPlan({images: fixtures().slice(1), now});
  assert.equal(plan.policies[0].action.type, "Keep");
  assert.deepEqual(plan.candidates.map((candidate) => candidate.digest), [digest(2)]);
});

test("refuses the wrong project or mode before making cloud calls", () => {
  assert.throws(() => run({project: "other", mode: "apply"}), /Usage/);
  assert.throws(() => run({project: "pi-agents-cloud", mode: "delete"}), /Usage/);
});
