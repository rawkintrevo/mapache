import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {parseArgs, run} from "./vm-cost-report.mjs";

test("cost report requires the production project and an input worksheet", () => {
  assert.deepEqual(parseArgs(["--project=pi-agents-cloud", "--input=worksheet.json"]), {
    project: "pi-agents-cloud", input: "worksheet.json",
  });
  assert.deepEqual(parseArgs(["--project", "pi-agents-cloud", "--input", "worksheet.json", "--output", "report.json"]), {
    project: "pi-agents-cloud", input: "worksheet.json", output: "report.json",
  });
  assert.throws(() => parseArgs(["--project=wrong", "--input=worksheet.json"]), /explicit_project_required/);
  assert.throws(() => parseArgs(["--project=pi-agents-cloud"]), /cost_input_required/);
  assert.throws(() => parseArgs(["--project=pi-agents-cloud", "--input=worksheet.json", "--unknown=x"]), /usage/);
});

test("CLI writes a new report and refuses to overwrite evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mapache-vm-cost-"));
  const inputPath = path.join(directory, "worksheet.json");
  const outputPath = path.join(directory, "report.json");
  const worksheet = {
    project: "pi-agents-cloud", usagePeriod: "monthly", usageCapturedAt: "2026-11-24T10:00:00.000Z",
    ratesCapturedAt: "2026-11-24T10:05:00.000Z", rateSource: "test",
    usage: Object.fromEntries([
      "retainedDiskGiB", "snapshotGiB", "computeActiveHours", "gatewayForwardingRuleHours",
      "gatewayProcessingGiB", "natHours", "natProcessingGiB", "networkEgressGiB", "loggingGiB",
      "operationsCount", "migrationOverlapHours", "orphanedResourceHours",
    ].map(key => [key, 0])),
    rates: Object.fromEntries([
      "retainedDiskUsdPerGiBMonth", "snapshotUsdPerGiBMonth", "computeUsdPerHour",
      "gatewayForwardingUsdPerRuleHour", "gatewayProcessingUsdPerGiB", "natUsdPerHour",
      "natProcessingUsdPerGiB", "networkEgressUsdPerGiB", "loggingUsdPerGiB", "operationUsdPer1000",
      "migrationOverlapUsdPerHour", "orphanedResourceUsdPerHour",
    ].map(key => [key, 0])),
  };
  try {
    await writeFile(inputPath, JSON.stringify(worksheet));
    await run(["--project=pi-agents-cloud", `--input=${inputPath}`, `--output=${outputPath}`]);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).totalMonthlyUsd, 0);
    await assert.rejects(run(["--project=pi-agents-cloud", `--input=${inputPath}`, `--output=${outputPath}`]), /EEXIST/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
