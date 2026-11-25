const PROJECT_ID = "pi-agents-cloud";

const USAGE_FIELDS = [
  ["retainedDiskGiB", "retained disk", "GiB-month", "retainedDisk"],
  ["snapshotGiB", "snapshots", "GiB-month", "snapshots"],
  ["computeActiveHours", "compute", "VM-hours", "compute"],
  ["gatewayForwardingRuleHours", "gateway forwarding rules", "rule-hours", "gatewayForwarding"],
  ["gatewayProcessingGiB", "gateway processing", "GiB", "gatewayProcessing"],
  ["natHours", "NAT", "gateway-hours", "nat"],
  ["natProcessingGiB", "NAT processing", "GiB", "natProcessing"],
  ["networkEgressGiB", "network egress", "GiB", "networkEgress"],
  ["loggingGiB", "logging", "GiB", "logging"],
  ["operationsCount", "operations", "operations", "operations"],
  ["migrationOverlapHours", "migration overlap", "hours", "migrationOverlap"],
  ["orphanedResourceHours", "failed/orphaned resources", "resource-hours", "orphanedResources"],
];

const RATE_FIELDS = [
  ["retainedDiskUsdPerGiBMonth", "USD/GiB-month"],
  ["snapshotUsdPerGiBMonth", "USD/GiB-month"],
  ["computeUsdPerHour", "USD/VM-hour"],
  ["gatewayForwardingUsdPerRuleHour", "USD/rule-hour"],
  ["gatewayProcessingUsdPerGiB", "USD/GiB"],
  ["natUsdPerHour", "USD/gateway-hour"],
  ["natProcessingUsdPerGiB", "USD/GiB"],
  ["networkEgressUsdPerGiB", "USD/GiB"],
  ["loggingUsdPerGiB", "USD/GiB"],
  ["operationUsdPer1000", "USD/1,000 operations"],
  ["migrationOverlapUsdPerHour", "USD/hour"],
  ["orphanedResourceUsdPerHour", "USD/resource-hour"],
];

const LINE_ITEMS = USAGE_FIELDS.map(([usage, label, unit, key], index) => ({
  key,
  usage,
  label,
  unit,
  rate: RATE_FIELDS[index][0],
  rateUnit: RATE_FIELDS[index][1],
  divisor: usage === "operationsCount" ? 1000 : 1,
}));

export {PROJECT_ID, RATE_FIELDS, USAGE_FIELDS};

export function buildVmCostReport(input, {generatedAt = new Date()} = {}) {
  validateInput(input);
  const generated = validTimestamp(generatedAt instanceof Date ? generatedAt.toISOString() : generatedAt, "generatedAt");
  const lineItems = LINE_ITEMS.map(item => {
    const quantity = input.usage[item.usage];
    const rateUsd = input.rates[item.rate];
    const costUsd = roundUsd(quantity * rateUsd / item.divisor);
    if (!Number.isFinite(costUsd)) throw costError("cost_overflow");
    return {key: item.key, label: item.label, quantity, unit: item.unit, rateUsd,
      rateUnit: item.rateUnit, costUsd};
  });
  const totalMonthlyUsd = roundUsd(lineItems.reduce((total, item) => total + item.costUsd, 0));
  if (!Number.isFinite(totalMonthlyUsd)) throw costError("cost_overflow");
  return {
    version: 1,
    kind: "vm-monthly-cost-report",
    project: input.project,
    generatedAt: generated,
    evidence: {
      usagePeriod: input.usagePeriod,
      usageCapturedAt: input.usageCapturedAt,
      ratesCapturedAt: input.ratesCapturedAt,
      rateSource: input.rateSource,
    },
    complete: true,
    lineItems,
    totalMonthlyUsd,
  };
}

function validateInput(input) {
  if (!isPlainObject(input)) throw costError("cost_input_object_required");
  exactKeys(input, ["project", "usagePeriod", "usageCapturedAt", "ratesCapturedAt", "rateSource", "usage", "rates"], "cost_input");
  if (input.project !== PROJECT_ID) throw costError("explicit_project_required");
  if (input.usagePeriod !== "monthly") throw costError("usage_period_must_be_monthly");
  validTimestamp(input.usageCapturedAt, "usageCapturedAt");
  validTimestamp(input.ratesCapturedAt, "ratesCapturedAt");
  if (typeof input.rateSource !== "string" || input.rateSource.trim().length < 1 || input.rateSource.length > 512) {
    throw costError("rate_source_required");
  }
  validateNumericMap(input.usage, USAGE_FIELDS.map(([key]) => key), "usage");
  validateNumericMap(input.rates, RATE_FIELDS.map(([key]) => key), "rates");
}

function validateNumericMap(value, keys, name) {
  if (!isPlainObject(value)) throw costError(`${name}_object_required`);
  exactKeys(value, keys, name);
  for (const key of keys) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
      throw costError(`${name}_${key}_must_be_non_negative_number`);
    }
  }
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw costError(`${name}_fields_incomplete`);
  }
}

function validTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw costError(`${name}_invalid`);
  return new Date(value).toISOString();
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function costError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
