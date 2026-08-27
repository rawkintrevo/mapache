import {render, screen} from "@testing-library/react";
import {describe, expect, test} from "vitest";
import {ResourceUtilization, getUtilizationTone} from "./ResourceUtilization.jsx";

const sample = (cpuPercent = 42.5, memoryPercent = 50) => ({
  type: "metrics",
  sampledAt: 1700000000000,
  cpu: {percent: cpuPercent, limitCores: 2},
  memory: {usedBytes: 1610612736, limitBytes: 4294967296, percent: memoryPercent},
});

describe("ResourceUtilization", () => {
  test("renders accessible CPU and RAM meters with live values", () => {
    render(<ResourceUtilization sample={sample()} connectionState="connected" />);

    expect(screen.getByRole("meter", {name: "CPU utilization"})).toHaveAttribute("aria-valuenow", "42.5");
    expect(screen.getByRole("meter", {name: "RAM utilization"})).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("43%")).toBeInTheDocument();
    expect(screen.getByText("1.5 GiB/4 GiB")).toBeInTheDocument();
  });

  test("renders an unavailable state without throwing", () => {
    render(<ResourceUtilization connectionState="unavailable" />);
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByRole("meter", {name: "CPU utilization"})).not.toHaveAttribute("aria-valuenow");
  });
});

test("uses healthy, warning, and danger tones at the agreed thresholds", () => {
  expect(getUtilizationTone(79.9)).toBe("healthy");
  expect(getUtilizationTone(80)).toBe("warning");
  expect(getUtilizationTone(94.9)).toBe("warning");
  expect(getUtilizationTone(95)).toBe("danger");
});
