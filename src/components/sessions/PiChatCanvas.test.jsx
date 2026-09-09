import {render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {PiChatCanvas} from "./PiChatCanvas.jsx";

const originalWebSocket = globalThis.WebSocket;
let sockets;

class MockWebSocket {
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

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  serverMessage(message) {
    this.emit("message", {data: JSON.stringify(message)});
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

describe("PiChatCanvas", () => {
  beforeEach(() => {
    sockets = [];
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  function renderCanvas(onOpenTerminal = vi.fn()) {
    const view = render(
      <PiChatCanvas
        onOpenTerminal={onOpenTerminal}
        sessionId="session-1"
        sessionName="Pi smoke"
        socketUrl="ws://runner.example/chat"
      />,
    );
    const socket = sockets[0];
    socket.open();
    socket.serverMessage({type: "snapshot", messages: []});
    return {onOpenTerminal, socket, ...view};
  }

  test("submits on Enter, keeps Shift+Enter multiline, shows pending/working, and reconciles completed turns", async () => {
    const user = userEvent.setup();
    const {socket} = renderCanvas();
    const composer = screen.getByRole("textbox", {name: "Message Pi"});

    await user.type(composer, "first line");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(composer, "second line");
    expect(composer).toHaveValue("first line\nsecond line");

    await user.clear(composer);
    await user.type(composer, "show me Markdown");
    await user.keyboard("{Enter}");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({type: "prompt", text: "show me Markdown"});
    expect(screen.getAllByRole("article", {name: "You message"})).toHaveLength(1);

    socket.serverMessage({type: "prompt_ack", clientId: socket.sent[0].clientId});
    await waitFor(() => expect(screen.getByText("Pi is working…")).toBeInTheDocument());
    socket.serverMessage({type: "message", message: {id: "u2", role: "user", markdown: "show me Markdown"}});
    socket.serverMessage({type: "message", message: {id: "a2", role: "assistant", markdown: "# Here you go"}});
    await waitFor(() => {
      expect(screen.getByRole("heading", {name: "Here you go"})).toBeInTheDocument();
      expect(screen.getAllByRole("article", {name: "You message"})).toHaveLength(1);
      expect(screen.queryByText("Pi is working…")).not.toBeInTheDocument();
    });
  });

  test("prevents empty submissions and offers Terminal fallback for a safe error", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const {socket} = renderCanvas(onOpenTerminal);
    const send = screen.getByRole("button", {name: "Send"});
    expect(send).toBeDisabled();
    await user.click(send);
    expect(socket.sent).toHaveLength(0);

    socket.serverMessage({type: "error", code: "unauthorized"});
    await waitFor(() => expect(screen.getByText("Chat access is unavailable")).toBeInTheDocument());
    await user.click(screen.getByRole("button", {name: "Open Terminal"}));
    expect(onOpenTerminal).toHaveBeenCalledOnce();
  });
});
