import {describe, expect, test} from "vitest";
import {deriveResourceMetricsSocketUrl} from "./resourceMetrics.js";

describe("deriveResourceMetricsSocketUrl", () => {
  test("converts signed runner URLs to the metrics socket", () => {
    expect(deriveResourceMetricsSocketUrl(
        "https://runner.example/?replay=1&mapache_access=signed.token#terminal",
    )).toBe("wss://runner.example/metrics?mapache_access=signed.token");
  });

  test("supports local HTTP URLs and rejects invalid protocols", () => {
    expect(deriveResourceMetricsSocketUrl("http://127.0.0.1:8080/?mapache_access=local-token"))
        .toBe("ws://127.0.0.1:8080/metrics?mapache_access=local-token");
    expect(deriveResourceMetricsSocketUrl("ftp://runner.example/"))
        .toBeNull();
    expect(deriveResourceMetricsSocketUrl("not-a-url")).toBeNull();
  });
});
