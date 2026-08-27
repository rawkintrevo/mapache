import {act, renderHook} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {usePiChat} from "./usePiChat.js";

const originalWebSocket = globalThis.WebSocket;
let sockets;

class MockWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    sockets.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(value) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("not open");
    this.sent.push(JSON.parse(value));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  serverMessage(message) {
    this.emit("message", {data: typeof message === "string" ? message : JSON.stringify(message)});
  }

  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const snapshot = {
  type: "snapshot",
  messages: [{id: "u1", role: "user", markdown: "hello", createdAt: null}],
};

describe("usePiChat", () => {
  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  test("connects, replays snapshots, deduplicates messages, tracks ack/status, and sends prompts", () => {
    const {result} = renderHook(() => usePiChat({enabled: true, sessionId: "session-1", socketUrl: "ws://runner/chat"}));
    const socket = sockets[0];
    expect(result.current.connectionState).toBe("connecting");

    act(() => socket.open());
    expect(result.current.connectionState).toBe("connected");
    act(() => socket.serverMessage(snapshot));
    act(() => socket.serverMessage({type: "message", message: {id: "a1", role: "assistant", markdown: "done"}}));
    act(() => socket.serverMessage({type: "message", message: {id: "a1", role: "assistant", markdown: "duplicate"}}));
    act(() => socket.serverMessage({type: "prompt_ack", clientId: "client-1"}));
    act(() => socket.serverMessage({type: "status", status: "working"}));
    expect(result.current.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
    expect(result.current.acknowledgements).toEqual({"client-1": true});
    expect(result.current.status).toBe("working");

    act(() => {
      expect(result.current.sendPrompt({clientId: "client-1", text: "build it"})).toBe(true);
    });
    expect(socket.sent).toEqual([{type: "prompt", clientId: "client-1", text: "build it"}]);
  });

  test("replaces messages on reset and reconnects with bounded delays", () => {
    const {result} = renderHook(() => usePiChat({enabled: true, sessionId: "session-1", socketUrl: "ws://runner/chat"}));
    const first = sockets[0];
    act(() => {
      first.open();
      first.serverMessage(snapshot);
      first.serverMessage({type: "reset", messages: [{id: "u2", role: "user", markdown: "new"}]});
      first.disconnect();
    });
    expect(result.current.messages.map((message) => message.id)).toEqual(["u2"]);
    expect(result.current.connectionState).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(499));
    expect(sockets).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(sockets).toHaveLength(2);
    act(() => sockets[1].open());
    expect(result.current.connectionState).toBe("connected");
  });

  test("does not reconnect after authentication failure or repeated malformed data", () => {
    const {result} = renderHook(() => usePiChat({enabled: true, sessionId: "session-1", socketUrl: "ws://runner/chat"}));
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.serverMessage({type: "unknown"});
      socket.serverMessage("not-json");
      socket.serverMessage({type: "unknown"});
    });
    expect(result.current.error).toBe("protocol_error");
    act(() => socket.serverMessage({type: "error", code: "unauthorized"}));
    expect(result.current.connectionState).toBe("failed");
    act(() => vi.advanceTimersByTime(10000));
    expect(sockets).toHaveLength(1);
  });

  test("ignores stale events after a session switch and cleans up sockets/timers", () => {
    const {result, rerender, unmount} = renderHook(
        (props) => usePiChat(props),
        {initialProps: {enabled: true, sessionId: "session-1", socketUrl: "ws://runner/one"}},
    );
    const first = sockets[0];
    act(() => first.open());
    rerender({enabled: true, sessionId: "session-2", socketUrl: "ws://runner/two"});
    const second = sockets[1];
    act(() => {
      first.serverMessage({type: "message", message: {id: "stale", role: "assistant", markdown: "old"}});
      second.open();
      second.serverMessage({type: "message", message: {id: "fresh", role: "assistant", markdown: "new"}});
    });
    expect(result.current.messages.map((message) => message.id)).toEqual(["fresh"]);
    unmount();
    expect(first.readyState).toBe(3);
    expect(second.readyState).toBe(3);
    act(() => vi.advanceTimersByTime(10000));
    expect(sockets).toHaveLength(2);
  });
});
