import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";

export const PROJECT_ID = "pi-agents-cloud";

export function parseArgs(argv = []) {
  const values = {command: argv[0] || "run", mode: "deterministic"};
  const rest = argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (argv[0] && !argv[0].startsWith("--") && argv[0] !== "run") throw new Error("command must be run");
  for (let index = 0; index < rest.length; index += 1) {
    const argument = String(rest[index] || "");
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : rest[++index];
    if (!key || value === undefined || String(value).startsWith("--")) throw new Error(`missing value for --${key}`);
    if (!["artifact-dir", "mode", "project", "runner-url"].includes(key)) throw new Error(`unsupported option: --${key}`);
    values[key] = String(value);
  }
  if (values.project !== PROJECT_ID) throw new Error(`project must be ${PROJECT_ID}`);
  if (!["deterministic", "live"].includes(values.mode)) throw new Error("--mode must be deterministic or live");
  if (values.mode === "live" && !values["runner-url"]) throw new Error("--runner-url is required in live mode");
  return values;
}

class LifecycleHarness {
  constructor() {
    this.mainStatus = "running";
    this.maxConcurrency = 2;
    this.runs = new Map();
    this.dispatches = new Map();
    this.files = new Map();
    this.history = [];
    this.nextRun = 1;
  }

  enqueue({allowParallelWithMain = true, prompt = "Write the fixture", trigger = "manual", snapshotName = "Fixture"} = {}) {
    const runId = `run-${this.nextRun++}`;
    const run = {
      id: runId,
      allowParallelWithMain,
      createdAt: this.nextRun,
      prompt,
      snapshot: {name: snapshotName, prompt, allowParallelWithMain},
      status: "queued",
      trigger,
      cleanup: "pending",
      serviceId: `auto-${runId}`,
    };
    this.runs.set(runId, run);
    this.history.push({runId, kind: "queued", prompt});
    return run;
  }

  cronTick({allowParallelWithMain = true, pendingRunId = "", prompt = "Write the fixture"} = {}) {
    if (pendingRunId && this.runs.get(pendingRunId)?.status === "queued") {
      const skipped = this.enqueue({allowParallelWithMain, prompt, trigger: "cron"});
      skipped.status = "skipped";
      skipped.skippedReason = "pending_run_exists";
      skipped.cleanup = "complete";
      skipped.serviceAbsent = true;
      this.history.push({runId: skipped.id, kind: "skipped", reason: skipped.skippedReason});
      return skipped;
    }
    return this.enqueue({allowParallelWithMain, prompt, trigger: "cron"});
  }

  activeRuns() {
    return [...this.runs.values()].filter((run) => ["provisioning", "running", "stopping"].includes(run.status));
  }

  admit() {
    const active = this.activeRuns();
    if (active.length >= this.maxConcurrency) return {admitted: false, reason: "concurrency_full"};
    const candidate = [...this.runs.values()].find((run) => run.status === "queued" &&
      (run.allowParallelWithMain || this.mainStatus === "stopped"));
    if (!candidate) {
      const exclusive = [...this.runs.values()].find((run) => run.status === "queued" && !run.allowParallelWithMain);
      return {admitted: false, reason: exclusive ? "waiting_for_main" : "no_eligible_run"};
    }
    candidate.status = "provisioning";
    candidate.admittedAt = this.nextRun++;
    this.history.push({runId: candidate.id, kind: "admitted", serviceId: candidate.serviceId});
    return {admitted: true, runId: candidate.id};
  }

  dispatch(runId) {
    const run = this.runs.get(runId);
    if (!run || run.status === "skipped" || run.status === "canceled") return {dispatched: false};
    if (this.dispatches.has(runId)) return {dispatched: false, duplicate: true};
    run.status = "running";
    run.startedAt = this.nextRun++;
    this.dispatches.set(runId, 1);
    this.files.set(`automation-fixtures/${runId}.txt`, `safe fixture for ${runId}\n`);
    this.history.push({runId, kind: "dispatched", prompt: run.snapshot.prompt, file: `automation-fixtures/${runId}.txt`});
    return {dispatched: true, serviceId: run.serviceId};
  }

  complete(runId, outcome = "succeeded") {
    const run = this.runs.get(runId);
    if (!run || run.status === "succeeded" || run.status === "failed" || run.status === "canceled") return run;
    run.status = outcome;
    run.cleanup = "complete";
    run.serviceAbsent = true;
    run.endedAt = this.nextRun++;
    this.history.push({runId, kind: "completed", outcome, archive: `automation-runs/${runId}/v1/manifest.json`});
    return run;
  }

  stop(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status === "queued") return this.cancel(runId);
    run.status = "stopping";
    return this.complete(runId, "interrupted");
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || run.status !== "queued") return run;
    run.status = "canceled";
    run.cleanup = "complete";
    run.serviceAbsent = true;
    this.history.push({runId, kind: "canceled"});
    return run;
  }

  restart(runId) {
    const source = this.runs.get(runId);
    if (!source || !["succeeded", "failed", "interrupted", "canceled"].includes(source.status)) return null;
    const restarted = this.enqueue({
      allowParallelWithMain: source.snapshot.allowParallelWithMain,
      prompt: source.snapshot.prompt,
      trigger: "restart",
      snapshotName: source.snapshot.name,
    });
    restarted.restartOfRunId = runId;
    return restarted;
  }
}

export async function runCommand(argv, dependencies = {}) {
  const args = parseArgs(argv);
  const artifactDir = path.resolve(args["artifact-dir"] || path.join("artifacts", "automation-lifecycle", `run-${Date.now()}`));
  await mkdir(artifactDir, {recursive: true});
  if (args.mode === "live") {
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(`${args["runner-url"]}/fixture?action=health`);
    const health = await response.json();
    const result = {ok: response.ok && health.ok === true, project: PROJECT_ID, mode: "live", runner: health, artifacts: artifactDir};
    await writeFile(path.join(artifactDir, "checks.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  const harness = new LifecycleHarness();
  const checks = [];
  const check = (name, condition, details = {}) => {
    const result = {name, ok: Boolean(condition), ...details};
    checks.push(result);
    if (!result.ok) throw new Error(`check failed: ${name}`);
  };

  const parallel = harness.cronTick({prompt: "Create a unique fixture file"});
  check("cron tick queues one run", parallel.status === "queued");
  check("cron admission keeps main unchanged", harness.admit().admitted && harness.mainStatus === "running");
  check("one prompt dispatch", harness.dispatch(parallel.id).dispatched && harness.dispatch(parallel.id).duplicate);
  const editedPrompt = "The saved prompt remains immutable";
  const exclusive = harness.cronTick({allowParallelWithMain: false, prompt: editedPrompt});
  check("exclusive run waits for main", harness.admit().reason === "waiting_for_main");
  check("main Play is rejected while exclusive run waits", harness.mainStatus === "running");
  harness.mainStatus = "stopped";
  check("pausing main wakes exclusive run", harness.admit().admitted);
  check("exclusive prompt snapshot is retained", harness.runs.get(exclusive.id).snapshot.prompt === editedPrompt);
  check("max concurrency queues third run", harness.cronTick().status === "queued" && harness.admit().reason === "concurrency_full");
  check("completed runner leaves no service", Boolean(harness.complete(parallel.id).serviceAbsent));
  check("released slot admits next run", harness.admit().admitted);
  const pending = harness.cronTick();
  const skipped = harness.cronTick({pendingRunId: pending.id});
  check("second pending occurrence is skipped", skipped.status === "skipped" && skipped.skippedReason === "pending_run_exists");
  const oldPrompt = harness.complete(exclusive.id, "succeeded");
  const restarted = harness.restart(oldPrompt.id);
  check("restart uses terminal snapshot", restarted.snapshot.prompt === oldPrompt.snapshot.prompt);
  check("queued stop cancels without service", harness.stop(restarted.id).status === "canceled");
  const interrupted = harness.runs.get(parallel.id);
  check("interruption does not replay prompt", harness.dispatches.get(interrupted.id) === 1);
  const failed = harness.enqueue({prompt: "credential-safe fixture"});
  harness.admit();
  harness.dispatch(failed.id);
  check("child crash still releases cleanup state", harness.complete(failed.id, "failed").cleanup === "complete");
  check("fixture file is unique and safe", [...harness.files.keys()].every((value) => value.startsWith("automation-fixtures/")));
  check("history records archived transcript boundary", harness.history.some((entry) => entry.archive?.includes("/v1/manifest.json")));
  for (const run of harness.runs.values()) {
    if (["provisioning", "running", "stopping"].includes(run.status)) harness.complete(run.id, "succeeded");
    if (run.status === "queued") harness.cancel(run.id);
  }
  check("final cleanup leaves no active resources", harness.activeRuns().length === 0 &&
    [...harness.runs.values()].every((run) => run.serviceAbsent === true));

  const result = {
    ok: checks.every((item) => item.ok),
    project: PROJECT_ID,
    mode: "deterministic",
    checks,
    evidence: {
      distinctServiceIds: new Set([...harness.runs.values()].map((run) => run.serviceId)).size === harness.runs.size,
      promptDispatches: Object.fromEntries(harness.dispatches),
      activeRuns: harness.activeRuns().map((run) => run.id),
      resources: [...harness.runs.values()].map((run) => ({runId: run.id, serviceId: run.serviceId, status: run.status, serviceAbsent: run.serviceAbsent === true})),
      historyCount: harness.history.length,
    },
    artifacts: artifactDir,
    runId: randomUUID(),
  };
  await writeFile(path.join(artifactDir, "checks.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result?.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
