import assert from "node:assert/strict";
import test from "node:test";
import {buildVmCostReport} from "./vm-cost-model.mjs";

const input = {
  project: "pi-agents-cloud",
  usageCapturedAt: "2026-11-24T10:00:00.000Z",
  ratesCapturedAt: "2026-11-24T10:05:00.000Z",
  rateSource: "operator billing export 2026-11-24",
  usage: {
    retainedDiskGiB: 64, snapshotGiB: 32, computeActiveHours: 100,
    gatewayForwardingRuleHours: 720, gatewayProcessingGiB: 10,
    natHours: 720, natProcessingGiB: 8, networkEgressGiB: 4,
    loggingGiB: 2, operationsCount: 2500, migrationOverlapHours: 12,
    orphanedResourceHours: 3,
  },
  rates: {
    retainedDiskUsdPerGiBMonth: 0.1, snapshotUsdPerGiBMonth: 0.065, computeUsdPerHour: 0.05,
    gatewayForwardingUsdPerRuleHour: 0.025, gatewayProcessingUsdPerGiB: 0.01,
    natUsdPerHour: 0.02, natProcessingUsdPerGiB: 0.001, networkEgressUsdPerGiB: 0.12,
    loggingUsdPerGiB: 0.5, operationUsdPer1000: 0.2, migrationOverlapUsdPerHour: 0.05,
    orphanedResourceUsdPerHour: 0.1,
  },
};

test("cost report produces complete numeric line items and total", () => {
  const report = buildVmCostReport(input, {generatedAt: "2026-11-24T10:06:00.000Z"});
  assert.equal(report.complete, true);
  assert.equal(report.totalMonthlyUsd, 48.868);
  assert.deepEqual(report.evidence, {
    usageCapturedAt: input.usageCapturedAt,
    ratesCapturedAt: input.ratesCapturedAt,
    rateSource: input.rateSource,
  });
  assert.deepEqual(report.lineItems.find(item => item.key === "operations"), {
    key: "operations", label: "operations", quantity: 2500, unit: "operations",
    rateUsd: 0.2, rateUnit: "USD/1,000 operations", costUsd: 0.5,
  });
});

test("missing, string, negative, extra, and wrong-project inputs fail closed", () => {
  const cases = [
    ["missing rate", value => { delete value.rates.computeUsdPerHour; }, /rates_fields_incomplete/],
    ["string usage", value => { value.usage.computeActiveHours = "100"; }, /usage_computeActiveHours_must_be_non_negative_number/],
    ["negative rate", value => { value.rates.computeUsdPerHour = -1; }, /rates_computeUsdPerHour_must_be_non_negative_number/],
    ["extra usage", value => { value.usage.unpriced = 1; }, /usage_fields_incomplete/],
    ["wrong project", value => { value.project = "other-project"; }, /explicit_project_required/],
  ];
  for (const [, mutate, expected] of cases) {
    const candidate = structuredClone(input);
    mutate(candidate);
    assert.throws(() => buildVmCostReport(candidate), expected);
  }
});

test("explicit zero usage remains a complete, numeric report", () => {
  const candidate = structuredClone(input);
  for (const key of Object.keys(candidate.usage)) candidate.usage[key] = 0;
  const report = buildVmCostReport(candidate, {generatedAt: "2026-11-24T10:06:00.000Z"});
  assert.equal(report.complete, true);
  assert.equal(report.totalMonthlyUsd, 0);
  assert.ok(report.lineItems.every(item => item.costUsd === 0));
});

test("default report timestamp works and numeric overflow fails closed", () => {
  assert.match(buildVmCostReport(input).generatedAt, /^20\d\d-/);
  const candidate = structuredClone(input);
  candidate.usage.computeActiveHours = Number.MAX_VALUE;
  candidate.rates.computeUsdPerHour = Number.MAX_VALUE;
  assert.throws(() => buildVmCostReport(candidate), /cost_overflow/);
});
