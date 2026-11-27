import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

describe("automation workspace model selection", () => {
  it("inherits the model and provider key from the client that most recently selected a model", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-automation-model-"));
    try {
      const filePath = join(dir, "client-state.json");
      writeFileSync(filePath, JSON.stringify({
        "older-client": {
          lastActive: Date.now(),
          projects: [{ path: "/workspace", lastUsed: 100 }],
          projectModels: { "/workspace": "openai/gpt-4.1" },
          projectProviderKeys: { "/workspace": { openai: "older-key" } },
          projectModelUpdatedAt: { "/workspace": 300 },
        },
        "newer-client": {
          lastActive: Date.now(),
          projects: [{ path: "/workspace", lastUsed: 200 }],
          projectModels: { "/workspace": "openai/gpt-5" },
          projectProviderKeys: { "/workspace": { openai: "current-key" } },
          projectModelUpdatedAt: { "/workspace": 250 },
        },
      }));

      expect(new ClientStateStore(filePath).getMostRecentlySelectedProjectSelection("/workspace")).toEqual({
        modelId: "openai/gpt-4.1",
        providerKeys: { openai: "older-key" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no inherited selection when the workspace has no saved model", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-automation-model-"));
    try {
      const filePath = join(dir, "client-state.json");
      writeFileSync(filePath, JSON.stringify({ "other-client": { projects: [] } }));
      expect(new ClientStateStore(filePath).getMostRecentlySelectedProjectSelection("/workspace")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
