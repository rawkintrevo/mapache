import {describe, expect, test} from "vitest";
import {automationErrorMessage, automationReadiness, automationStorageSummary, hasAutomationModel} from "./automationReadiness.js";

describe("public automation readiness", () => {
  test("allows existing workspace storage without a prepared descriptor", () => {
    for (const sharedStorage of [{bucketName: "private", state: "ready"}, {configured: true, state: "legacy"}, {configured: false, state: "ready"}]) {
      expect(automationReadiness({storage: automationStorageSummary({sharedStorage})}).canEnable).toBe(true);
    }
    const storage = automationStorageSummary({sharedStorage: {configured: true, state: "ready", errorCode: null}, sharedStorageState: "legacy", sharedStorageErrorCode: "old"});
    expect(storage).toEqual({configured: true, state: "ready", errorCode: null});
    expect(automationReadiness({storage})).toMatchObject({ready: true, canEnable: true, canRun: true, reason: ""});
  });

  test.each([
    [{configured: true, state: "ready"}, {busy: true, busyAction: "load"}, /Loading/],
    [{configured: true, state: "ready"}, {busy: true, busyAction: "update"}, /Saving/],
    [{configured: true, state: "ready"}, {modelConfigured: false}, /automation's editor/],
  ])("explains each block without blocking an unrelated Disable", (storage, options, reason) => {
    expect(automationReadiness({storage, ...options, mutationBusy: false})).toMatchObject({canEnable: false, canRun: false, canDisable: true, reason: expect.stringMatching(reason)});
  });

  test("recognizes workspace model defaults and prerequisite errors", () => {
    expect(hasAutomationModel({}, {automationModelSelection: {providerId: "openai", modelId: "configured"}})).toBe(true);
    expect(hasAutomationModel({modelSelection: {providerId: "configured"}})).toBe(false);
    expect(hasAutomationModel({modelSelection: {modelId: "configured"}})).toBe(false);
    expect(hasAutomationModel({modelSelection: {providerId: "openai", modelId: " "}})).toBe(false);
    expect(hasAutomationModel()).toBe(false);
    expect(automationErrorMessage("missing_model_selection")).toMatch(/automation's editor/);
  });
});
