import {describe, expect, test} from "vitest";
import bundledCatalog from "./automationModelCatalog.json";
import {normalizeRemoteModelCatalog} from "./remoteModelCatalog.js";

describe("remote Pi model catalog", () => {
  test("overlays new models for providers supported by the installed runner", () => {
    const catalog = normalizeRemoteModelCatalog({
      "openai-codex": [{id: "gpt-6.2-sol", name: "GPT-6.2 Sol", type: "chat"}],
      azure: [{id: "gpt-6.2-sol", name: "GPT-6.2 Sol", type: "chat"}],
      meta: [{id: "muse-ember", name: "Muse Ember", type: "chat"}],
      openai: [{id: "gpt-6.2-sol", name: "GPT-6.2 Sol", type: "chat"}],
      images: [{id: "image-model", name: "Image", type: "image"}],
    });
    expect(catalog.providers["openai-codex"]["gpt-6.2-sol"]).toBe("GPT-6.2 Sol");
    expect(catalog.providers["azure-openai-responses"]["gpt-6.2-sol"]).toBe("GPT-6.2 Sol");
    expect(catalog.providers.openai["gpt-6.2-sol"]).toBe("GPT-6.2 Sol");
    expect(catalog.providers.meta).toBeUndefined();
    expect(catalog.providers["openai-codex"]["image-model"]).toBeUndefined();
    expect(catalog.providers.openai["gpt-4.1"]).toBe(bundledCatalog.providers.openai["gpt-4.1"]);
  });
});
