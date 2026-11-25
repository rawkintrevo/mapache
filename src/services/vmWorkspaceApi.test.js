import {describe, it, expect, vi} from "vitest";
import {withVmWorkspaces, pollVmSessions} from "./vmWorkspaceApi.js";

function fixture() {
  const workspace = {id: "vm", backend: "compute-engine", generation: 8, state: "active", currentSessionId: "s8"};
  const legacy = {getWorkspaces: vi.fn(async () => ({workspaces: [{id: "old"}]})), getSessions: vi.fn(), renameWorkspace: vi.fn(),
    getMachineConfiguration: vi.fn(), updateMachineConfiguration: vi.fn(),
    getWorkspaceRuntimePolicy: vi.fn(), updateWorkspaceRuntimePolicy: vi.fn(), setSessionLongRunning: vi.fn(),
    stopSession: vi.fn(), restartSession: vi.fn(), getSessionAccessUrls: vi.fn(), createWorkspaceUpload: vi.fn(), deleteWorkspace: vi.fn()};
  const request = vi.fn(async (url, options) => {
    if (url.endsWith("/workspaces")) return {workspaces: [workspace], nextCursor: null};
    if (url.endsWith("/sessions")) return {workspace: {...workspace}, sessions: [{id: workspace.currentSessionId}]};
    return {ok: true, options};
  });
  const api = withVmWorkspaces(legacy, request, {requestId: () => "request-id"});
  return {api, legacy, request, workspace};
}
describe("VM frontend provider routing", () => {
  it("preserves the editor's expected version when routing configuration saves", async () => {
    const f = fixture(); await f.api.getWorkspaces();
    await f.api.getMachineConfiguration("vm");
    expect(f.request.mock.lastCall[0]).toMatch(/\/vm\/configuration$/);
    const patch = {expectedGeneration: 7, expectedVersion: 2, environmentEntryIds: []};
    await f.api.updateMachineConfiguration("vm", patch);
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/configuration$/), {method: "PATCH", body: patch});
    expect(f.legacy.updateMachineConfiguration).not.toHaveBeenCalled();
    await f.api.updateMachineConfiguration("old", patch);
    expect(f.legacy.updateMachineConfiguration).toHaveBeenCalledWith("old", patch);
  });
  it("keeps legacy calls unchanged and routes VM generation-aware actions without legacy fallback", async () => {
    const f = fixture(); expect((await f.api.getWorkspaces()).workspaces.map(w => w.id)).toEqual(["old", "vm"]);
    await f.api.stopSession("old", "legacy-session"); expect(f.legacy.stopSession).toHaveBeenCalledWith("old", "legacy-session");
    await f.api.renameWorkspace("vm", {name: "Renamed VM"});
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/rename$/), {method: "PATCH", body: {name: "Renamed VM", expectedGeneration: 8}});
    await f.api.restartSession("vm", "s8");
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/replace$/), {method: "POST", body: {expectedGeneration: 8, requestId: "request-id"}});
    f.workspace.state = "stopped"; await f.api.restartSession("vm", "s8");
    expect(f.request.mock.lastCall[0]).toMatch(/\/start$/);
    await expect(f.api.restartSession("vm", "stale")).rejects.toThrow("runtime changed");
    await f.api.deleteWorkspace("vm");
    expect(f.request.mock.lastCall[0]).toMatch(/\/delete$/);
    expect(f.legacy.deleteWorkspace).not.toHaveBeenCalled();
    f.request.mockRejectedValue(new Error("VM endpoint unavailable"));
    await expect(f.api.stopSession("vm", "s8")).rejects.toThrow("VM endpoint unavailable");
    expect(f.legacy.stopSession).toHaveBeenCalledTimes(1);
  });
  it("does not forget VM identity when admission is revoked", async () => {
    const f = fixture(); await f.api.getWorkspaces();
    f.request.mockResolvedValue({workspaces: [], nextCursor: null}); await f.api.getWorkspaces();
    expect(f.api.isVmWorkspace("vm")).toBe(true);
    await expect(f.api.deleteWorkspace("vm")).rejects.toThrow("Invalid VM workspace response");
  });
  it("routes runtime policy reads and generation-fenced saves to the VM API", async () => {
    const f = fixture(); await f.api.getWorkspaces();
    await f.api.getWorkspaceRuntimePolicy("vm");
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/runtime-policy$/), undefined);
    await f.api.updateWorkspaceRuntimePolicy("vm", {mode: "scheduled", schedule: {
      days: [1], startTime: "08:00", endTime: "18:00", timezone: "UTC",
    }});
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/runtime-policy$/), {
      method: "PATCH", body: {mode: "scheduled", schedule: {days: [1], startTime: "08:00", endTime: "18:00", timezone: "UTC"}, expectedGeneration: 8},
    });
    await f.api.setSessionLongRunning("vm", "s8", true);
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/runtime-policy$/), {
      method: "PATCH", body: {mode: "keep-running", schedule: null, expectedGeneration: 8},
    });
    expect(f.legacy.updateWorkspaceRuntimePolicy).not.toHaveBeenCalled();
  });
  it("routes VM uploads with the current generation and keeps legacy uploads unchanged", async () => {
    const f = fixture(); await f.api.getWorkspaces();
    const file = {name: "report.csv", size: 12};
    await f.api.createWorkspaceUpload("vm", file, "resume_123");
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/uploads$/), {
      method: "POST", body: {name: "report.csv", size: 12, expectedGeneration: 8, operationId: "resume_123"},
    });
    await f.api.createWorkspaceUpload("old", file);
    expect(f.legacy.createWorkspaceUpload).toHaveBeenCalledWith("old", file);
  });
  it("routes VM deletion to the durable lifecycle API without legacy fallback", async () => {
    const f = fixture(); await f.api.getWorkspaces();
    await f.api.deleteWorkspace("vm");
    expect(f.request).toHaveBeenLastCalledWith(expect.stringMatching(/\/vm\/delete$/), {
      method: "POST", body: {expectedGeneration: 8, requestId: "request-id"},
    });
    expect(f.legacy.deleteWorkspace).not.toHaveBeenCalled();
  });
  it("rejects provider collisions and pagination loops", async () => {
    const f = fixture(); f.legacy.getWorkspaces.mockResolvedValue({workspaces: [{id: "vm"}]});
    await expect(f.api.getWorkspaces()).rejects.toThrow("provider conflict");
    f.request.mockResolvedValue({workspaces: [], nextCursor: "same"});
    await expect(f.api.getWorkspaces()).rejects.toThrow("did not advance");
  });
  it("polls without overlapping requests and suppresses late callbacks after detachment", async () => {
    let resolve; const api = {getSessions: vi.fn(() => new Promise(r => { resolve = r; }))};
    const onSessions = vi.fn(); const schedule = vi.fn();
    const detach = pollVmSessions(api, "vm", onSessions, vi.fn(), {schedule});
    expect(schedule).not.toHaveBeenCalled(); detach(); resolve({sessions: [{id: "late"}]});
    await Promise.resolve(); await Promise.resolve();
    expect(onSessions).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled();
  });
});
