import {describe, expect, test} from "vitest";
import {
  calculateEstimatedHourlyPrice,
  calculateEstimatedUsageCost,
  formatEstimatedHourlyPrice,
  inferSessionSize,
  isValidSessionResourcePair,
  parseMemoryGiB,
} from "./sessionResources.js";

describe("session resource catalog helpers", () => {
  test("parses GiB and MiB memory values", () => {
    expect(parseMemoryGiB("2Gi")).toBe(2);
    expect(parseMemoryGiB("2GiB")).toBe(2);
    expect(parseMemoryGiB("512Mi")).toBe(0.5);
    expect(parseMemoryGiB("invalid")).toBeNull();
  });

  test("infers presets and custom resource pairs", () => {
    expect(inferSessionSize("1", "2Gi")).toBe("small");
    expect(inferSessionSize("2", "4Gi")).toBe("medium");
    expect(inferSessionSize("4", "8Gi")).toBe("large");
    expect(inferSessionSize("1", "1Gi")).toBe("custom");
  });

  test("enforces the Cloud Run resource constraints", () => {
    expect(isValidSessionResourcePair("1", "2Gi")).toBe(true);
    expect(isValidSessionResourcePair("1", "8Gi")).toBe(false);
    expect(isValidSessionResourcePair("2", "8Gi")).toBe(true);
    expect(isValidSessionResourcePair("2", "16Gi")).toBe(false);
    expect(isValidSessionResourcePair("4", "1Gi")).toBe(false);
    expect(isValidSessionResourcePair("4", "16Gi")).toBe(true);
    expect(isValidSessionResourcePair("4", "24Gi")).toBe(false);
    expect(isValidSessionResourcePair("6", "4Gi")).toBe(true);
    expect(isValidSessionResourcePair("6", "24Gi")).toBe(true);
    expect(isValidSessionResourcePair("6", "32Gi")).toBe(false);
    expect(isValidSessionResourcePair("8", "4Gi")).toBe(true);
    expect(isValidSessionResourcePair("8", "32Gi")).toBe(true);
    expect(isValidSessionResourcePair("8", "2Gi")).toBe(false);
  });

  test("calculates and formats the same hourly prices as Functions", () => {
    expect(calculateEstimatedHourlyPrice("1", "2Gi")).toBe(0.0792);
    expect(calculateEstimatedHourlyPrice("2", "4Gi")).toBe(0.1584);
    expect(calculateEstimatedHourlyPrice("4", "8Gi")).toBe(0.3168);
    expect(calculateEstimatedHourlyPrice("6", "24Gi")).toBe(0.5616);
    expect(calculateEstimatedHourlyPrice("8", "32Gi")).toBe(0.7488);
    expect(formatEstimatedHourlyPrice("1", "2Gi")).toBe("$0.0792/hr estimate");
    expect(calculateEstimatedUsageCost({cpuSeconds: 3600, memoryGbSeconds: 7200})).toBe(0.0792);
  });
});
