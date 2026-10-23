import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, test, vi} from "vitest";
import {AGENT_BOOTSTRAP_TIMEOUT_MS, PiWebUiCanvas, getAgentOrigin, parseBridgeMessage} from "./PiWebUiCanvas.jsx";

const firstUrl = "https://runner.example/agent/?mapache_access=first";

describe("PiWebUiCanvas", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  test("recovers a bootstrap that never sends readiness using the latest URL", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const {rerender} = render(<PiWebUiCanvas sessionName="Recovery" url={firstUrl} onAccessRefreshNeeded={refresh} />);
    const failedFrame = screen.getByTitle("Agent Recovery");
    const renewedUrl = "https://runner.example/agent/?mapache_access=renewed";
    rerender(<PiWebUiCanvas sessionName="Recovery" url={renewedUrl} onAccessRefreshNeeded={refresh} />);
    act(() => vi.advanceTimersByTime(AGENT_BOOTSTRAP_TIMEOUT_MS));
    const recoveredFrame = screen.getByTitle("Agent Recovery");
    expect(recoveredFrame).not.toBe(failedFrame);
    expect(recoveredFrame).toHaveAttribute("src", renewedUrl);
    expect(refresh).toHaveBeenCalledOnce();
    fireEvent(window, new MessageEvent("message", {
      data: {type: "mapache.agent.ready", version: 1},
      origin: "https://runner.example", source: recoveredFrame.contentWindow,
    }));
    act(() => vi.advanceTimersByTime(5 * AGENT_BOOTSTRAP_TIMEOUT_MS));
    expect(screen.getByTitle("Agent Recovery")).toBe(recoveredFrame);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  test("bounds failed bootstrap retries and allows a fresh manual attempt", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const {unmount} = render(<PiWebUiCanvas sessionName="Recovery" url={firstUrl} onAccessRefreshNeeded={refresh} />);
    for (let i = 0; i < 3; i++) act(() => vi.advanceTimersByTime(AGENT_BOOTSTRAP_TIMEOUT_MS));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Agent did not load")).toBeInTheDocument();
    const failedFrame = screen.getByTitle("Agent Recovery");
    act(() => vi.advanceTimersByTime(5 * AGENT_BOOTSTRAP_TIMEOUT_MS));
    expect(screen.getByTitle("Agent Recovery")).toBe(failedFrame);
    fireEvent.click(screen.getByRole("button", {name: "Retry Agent"}));
    expect(screen.getByTitle("Agent Recovery")).not.toBe(failedFrame);
    expect(screen.getByText("Loading Agent")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(3);
    unmount();
    act(() => vi.advanceTimersByTime(5 * AGENT_BOOTSTRAP_TIMEOUT_MS));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  test("sends access once on readiness and once for a new URL", () => {
    const {rerender} = render(<PiWebUiCanvas sessionName="Agent smoke" url={firstUrl} />);
    const frame = screen.getByTitle("Agent Agent smoke");
    const postMessage = vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(() => {});

    fireEvent(window, new MessageEvent("message", {
      data: {type: "mapache.agent.ready", version: 1},
      origin: "https://runner.example",
      source: frame.contentWindow,
    }));
    rerender(<PiWebUiCanvas sessionName="Agent smoke" url="https://runner.example/agent/?mapache_access=second" />);

    expect(screen.getByTitle("Agent Agent smoke")).toBe(frame);
    expect(frame).toHaveAttribute("src", firstUrl);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({agentUrl: expect.stringContaining("second")}), "https://runner.example");
    expect(postMessage).toHaveBeenCalledTimes(2);

    fireEvent(window, new MessageEvent("message", {
      data: {type: "mapache.agent.status", version: 1, status: "access-renewed"},
      origin: "https://runner.example",
      source: frame.contentWindow,
    }));
    expect(postMessage).toHaveBeenCalledTimes(2);
    postMessage.mockRestore();
  });

  test("does not renew or resend access when parent callbacks change", () => {
    const firstOnOpenChrome = vi.fn();
    const {rerender} = render(
      <PiWebUiCanvas onOpenChrome={firstOnOpenChrome} sessionName="Agent smoke" url={firstUrl} />,
    );
    const frame = screen.getByTitle("Agent Agent smoke");
    const postMessage = vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(() => {});

    fireEvent(window, new MessageEvent("message", {
      data: {type: "mapache.agent.ready", version: 1},
      origin: "https://runner.example",
      source: frame.contentWindow,
    }));
    expect(postMessage).toHaveBeenCalledTimes(1);
    postMessage.mockClear();

    rerender(<PiWebUiCanvas onOpenChrome={() => {}} sessionName="Agent smoke" url={firstUrl} />);

    expect(postMessage).not.toHaveBeenCalled();
    expect(screen.queryByText("Refreshing Agent access")).not.toBeInTheDocument();
    postMessage.mockRestore();
  });

  test("only handles renewal requests from the current frame and exact origin", () => {
    const onAccessRefreshNeeded = vi.fn();
    render(<PiWebUiCanvas onAccessRefreshNeeded={onAccessRefreshNeeded} sessionName="Agent smoke" url={firstUrl} />);
    const frame = screen.getByTitle("Agent Agent smoke");
    const dispatch = (source, origin) => fireEvent(window, new MessageEvent("message", {
      data: {type: "mapache.agent.renewal-request", version: 1, reason: "expired"},
      origin,
      source,
    }));

    dispatch(window, "https://runner.example");
    dispatch(frame.contentWindow, "https://evil.example");
    expect(onAccessRefreshNeeded).not.toHaveBeenCalled();

    dispatch(frame.contentWindow, "https://runner.example");
    expect(onAccessRefreshNeeded).toHaveBeenCalledOnce();
  });

  test("opens Chrome only for a typed request from the current frame and exact origin", () => {
    const onOpenChrome = vi.fn();
    render(<PiWebUiCanvas onOpenChrome={onOpenChrome} sessionName="Agent smoke" url={firstUrl} />);
    const frame = screen.getByTitle("Agent Agent smoke");
    const dispatch = (source, origin, surface = "chrome") => fireEvent(window, new MessageEvent("message", {
      data: {type: "mapache.agent.navigate", version: 1, surface},
      origin,
      source,
    }));

    dispatch(window, "https://runner.example");
    dispatch(frame.contentWindow, "https://evil.example");
    dispatch(frame.contentWindow, "https://runner.example", "terminal");
    expect(onOpenChrome).not.toHaveBeenCalled();

    dispatch(frame.contentWindow, "https://runner.example");
    expect(onOpenChrome).toHaveBeenCalledOnce();
  });

  test("reports invalid access URLs without mounting a frame", () => {
    render(<PiWebUiCanvas sessionName="Agent smoke" url="javascript:alert(1)" />);
    expect(screen.queryByTitle("Agent Agent smoke")).not.toBeInTheDocument();
    expect(screen.getByText("agent_access_unavailable")).toBeInTheDocument();
  });

  test("parses only safe bridge statuses", () => {
    const unsafe = parseBridgeMessage({type: "mapache.agent.status", version: 1, status: "access-error", error: "not-safe"});
    expect(unsafe).toMatchObject({status: "access-error"});
    expect(unsafe.error).toBeUndefined();
    expect(parseBridgeMessage({type: "mapache.agent.status", version: 2, status: "access-error"})).toBeNull();
    expect(parseBridgeMessage({type: "mapache.agent.navigate", version: 1, surface: "chrome"})).toEqual({
      type: "mapache.agent.navigate",
      version: 1,
      surface: "chrome",
    });
    expect(getAgentOrigin("wss://runner.example/agent/")).toBe("");
  });
});
