import {fireEvent, render, screen} from "@testing-library/react";
import {describe, expect, test, vi} from "vitest";
import {PiWebUiCanvas, getAgentOrigin, parseBridgeMessage} from "./PiWebUiCanvas.jsx";

const firstUrl = "https://runner.example/agent/?mapache_access=first";

describe("PiWebUiCanvas", () => {
  test("keeps one iframe while access rotates", async () => {
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
    expect(getAgentOrigin("wss://runner.example/agent/")).toBe("");
  });
});
