import {act, renderHook} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {useResourceMetrics} from "./useResourceMetrics.js";

const originalWebSocket = globalThis.WebSocket;
let sockets;

class MockWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    sockets.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  serverMessage(message) {
    this.emit("message", {data: JSON.stringify(message)});
  }

  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const sample = {
  type: "metrics",
  sampledAt: 1700000000000,
  cpu: {percent: 42.5, limitCores: 2},
  memory: {usedBytes: 100, limitBytes: 200, percent: 50},
};

describe("useResourceMetrics", () => {
  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  test("connects and stores validated samples", () => {
    const {result} = renderHook(() => useResourceMetrics({
      enabled: true,
      sessionId: "session-1",
      socketUrl: "ws://runner/metrics",
    }));
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.serverMessage(sample);
    });
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.sample).toEqual(sample);
  });

  test("reconnects and ignores malformed samples", () => {
    const {result} = renderHook(() => useResourceMetrics({
      enabled: true,
      sessionId: "session-1",
      socketUrl: "ws://runner/metrics",
    }));
    const first = sockets[0];
    act(() => {
      first.open();
      first.serverMessage({type: "metrics", cpu: {percent: 200}});
      first.disconnect();
    });
    expect(result.current.sample).toBeNull();
    expect(result.current.connectionState).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(500));
    expect(sockets).toHaveLength(2);
  });

  test("cleans up stale sockets when the session changes", () => {
    const {result, rerender, unmount} = renderHook(
        (props) => useResourceMetrics(props),
        {initialProps: {enabled: true, sessionId: "session-1", socketUrl: "ws://runner/one"}},
    );
    const first = sockets[0];
    rerender({enabled: true, sessionId: "session-2", socketUrl: "ws://runner/two"});
    const second = sockets[1];
    act(() => {
      first.serverMessage(sample);
      second.open();
      second.serverMessage(sample);
    });
    expect(result.current.sample).toEqual(sample);
    unmount();
    expect(first.readyState).toBe(3);
    expect(second.readyState).toBe(3);
  });
});
