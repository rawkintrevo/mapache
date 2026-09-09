import {describe, expect, test, vi} from "vitest";
import {loadSelectedSessionPanelsConcurrently} from "../workflows/selectedSessionPanels.js";

describe("selected-session panel loading", () => {
  test("starts independent panels together and preserves mixed outcomes", async () => {
    const started = [];
    let resolveGit;
    const loaders = {
      git: vi.fn(() => {
        started.push("git");
        return new Promise((resolve) => {
          resolveGit = resolve;
        });
      }),
      packages: vi.fn(() => {
        started.push("packages");
        return Promise.reject(new Error("packages unavailable"));
      }),
      skills: vi.fn(() => {
        started.push("skills");
        return Promise.resolve("skills loaded");
      }),
    };

    const loading = loadSelectedSessionPanelsConcurrently(loaders);
    await Promise.resolve();

    expect(started).toEqual(["git", "packages", "skills"]);
    resolveGit("git loaded");
    const outcomes = await loading;

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(loaders.git).toHaveBeenCalledOnce();
    expect(loaders.packages).toHaveBeenCalledOnce();
    expect(loaders.skills).toHaveBeenCalledOnce();
  });
});
