import {describe, expect, test} from "vitest";
import {automationErrorMessage, automationReadiness, automationStorageSummary, hasAutomationModel} from "./automationReadiness.js";

describe("public automation readiness", () => {
  test("requires public configuration and server readiness, never a private bucket name", () => {
    for (const sharedStorage of [{bucketName: "private", state: "ready"}, {configured: true, state: "legacy"}, {configured: false, state: "ready"}]) {
      expect(automationReadiness({storage: automationStorageSummary({sharedStorage})}).canEnable).toBe(false);
    }
    const storage = automationStorageSummary({sharedStorage: {configured: true, state: "ready", errorCode: null}, sharedStorageState: "legacy", sharedStorageErrorCode: "old"});
    expect(storage).toEqual({configured: true, state: "ready", errorCode: null});
    expect(automationReadiness({storage})).toMatchObject({ready: true, canEnable: true, canRun: true, reason: ""});
  });

  test.each([
    [{configured: false, state: "legacy"}, {}, /operator/],
    [{configured: true, state: "legacy"}, {}, /Revalidate/],
    [{configured: true, state: "error", errorCode: "bucket_missing"}, {}, /bucket_missing/],
    [{configured: true, state: "preparing"}, {}, /in progress/],
    [{configured: true, state: "ready"}, {busy: true, busyAction: "load"}, /Loading/],
    [{configured: true, state: "ready"}, {busy: true, busyAction: "update"}, /Saving/],
    [{configured: true, state: "ready"}, {modelConfigured: false}, /Agent settings/],
  ])("explains each block without blocking an unrelated Disable", (storage, options, reason) => {
    expect(automationReadiness({storage, ...options, mutationBusy: false})).toMatchObject({canEnable: false, canRun: false, canDisable: true, reason: expect.stringMatching(reason)});
  });

  test("recognizes workspace model defaults and prerequisite errors", () => {
    expect(hasAutomationModel({}, {automationModelSelection: {modelId: "configured"}})).toBe(true);
    expect(hasAutomationModel({modelSelection: {providerId: "configured"}})).toBe(true);
    expect(hasAutomationModel()).toBe(false);
    expect(automationErrorMessage("missing_model_selection")).toMatch(/Agent settings/);
    expect(automationErrorMessage("automation_shared_storage_not_ready")).toMatch(/revalidate/);
  });
});
