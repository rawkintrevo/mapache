import {describe, expect, test} from "vitest";
import {deriveShellUrl} from "./shell.js";

describe("deriveShellUrl", () => {
  test("preserves the signed runner origin and access token", () => {
    expect(deriveShellUrl("https://runner.example/?replay=1&mapache_access=signed-token#terminal")).toBe(
        "https://runner.example/shell?mapache_access=signed-token",
    );
  });

  test("returns null for malformed URLs", () => {
    expect(deriveShellUrl("not-a-url")).toBeNull();
  });
});
