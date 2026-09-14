import {act, renderHook, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {sessionAccessTimings, useSessionAccessUrls} from "./useSessionAccessUrls.js";

describe("useSessionAccessUrls", () => {
  beforeEach(() => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderAccessHook(loadAccessUrls) {
    return renderHook(() => useSessionAccessUrls({
      enabled: true,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      serviceUrl: "https://runner.example",
      loadAccessUrls,
    }));
  }

  test("loads access URLs and renews them before expiration", async () => {
    const now = Date.now();
    const loadAccessUrls = vi.fn()
        .mockResolvedValueOnce({terminalUrl: "https://runner/one", expiresAt: new Date(now + 10 * 60 * 1000).toISOString()})
        .mockResolvedValueOnce({terminalUrl: "https://runner/two", expiresAt: new Date(now + 20 * 60 * 1000).toISOString()});
    const {result} = renderAccessHook(loadAccessUrls);
    await waitFor(() => expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/one"));

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/two"));
    expect(loadAccessUrls).toHaveBeenCalledTimes(2);
  });

  test("gives short-lived access fixtures time to settle before renewing", async () => {
    const now = Date.now();
    const loadAccessUrls = vi.fn()
        .mockResolvedValueOnce({terminalUrl: "https://runner/short-one", expiresAt: new Date(now + 4 * 1000).toISOString()})
        .mockResolvedValueOnce({terminalUrl: "https://runner/short-two", expiresAt: new Date(now + 4 * 1000).toISOString()});
    const {result} = renderAccessHook(loadAccessUrls);
    await waitFor(() => expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/short-one"));

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(loadAccessUrls).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/short-two"));
    expect(loadAccessUrls).toHaveBeenCalledTimes(2);
  });

  test("keeps working URLs on renewal failure and rate-limits recovery refreshes", async () => {
    const loadAccessUrls = vi.fn()
        .mockResolvedValueOnce({terminalUrl: "https://runner/one"})
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce({terminalUrl: "https://runner/two"});
    const {result} = renderAccessHook(loadAccessUrls);
    await waitFor(() => expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/one"));

    act(() => {
      expect(result.current.refreshAfterConnectionFailure()).toBe(true);
      expect(result.current.refreshAfterConnectionFailure()).toBe(false);
    });
    await waitFor(() => expect(loadAccessUrls).toHaveBeenCalledTimes(2));
    expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/one");
    expect(result.current.error).toBe("temporary");

    act(() => vi.advanceTimersByTime(sessionAccessTimings.failureRefreshCooldownMs));
    act(() => expect(result.current.refreshAfterConnectionFailure()).toBe(true));
    await waitFor(() => expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/two"));
  });

  test("backs off repeated browser access refresh failures", async () => {
    const loadAccessUrls = vi.fn()
        .mockResolvedValueOnce({terminalUrl: "https://runner/one"})
        .mockRejectedValue(new Error("temporary"));
    const {result} = renderAccessHook(loadAccessUrls);
    await waitFor(() => expect(result.current.accessUrls?.terminalUrl).toBe("https://runner/one"));

    act(() => expect(result.current.refreshAfterConnectionFailure()).toBe(true));
    await waitFor(() => expect(loadAccessUrls).toHaveBeenCalledTimes(2));

    act(() => vi.advanceTimersByTime(sessionAccessTimings.failureRefreshCooldownMs));
    act(() => expect(result.current.refreshAfterConnectionFailure()).toBe(true));
    await waitFor(() => expect(loadAccessUrls).toHaveBeenCalledTimes(3));

    act(() => vi.advanceTimersByTime(sessionAccessTimings.failureRefreshCooldownMs));
    act(() => expect(result.current.refreshAfterConnectionFailure()).toBe(false));
    act(() => vi.advanceTimersByTime(sessionAccessTimings.failureRefreshCooldownMs));
    act(() => expect(result.current.refreshAfterConnectionFailure()).toBe(true));
    await waitFor(() => expect(loadAccessUrls).toHaveBeenCalledTimes(4));
  });
});
