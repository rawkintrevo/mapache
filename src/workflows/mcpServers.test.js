import {describe, expect, test} from "vitest";
import {editMcpServerFormState, resetMcpServerFormState} from "./mcpServers.js";

describe("MCP server editor state", () => {
  test("normalizes an existing stdio server into the shared editor form", () => {
    const state = {mcpServers: {error: "old error", message: "old message", form: {}}};

    editMcpServerFormState(state, {
      name: "chrome-devtools",
      server: {command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], env: {TOKEN: "secret-ref"}},
    });

    expect(state.mcpServers.form).toEqual({
      name: "chrome-devtools",
      originalName: "chrome-devtools",
      editing: true,
      transport: "stdio",
      command: "npx",
      args: "-y chrome-devtools-mcp@latest",
      url: "",
      env: "TOKEN=secret-ref",
    });
    expect(state.mcpServers.error).toBe("");
    expect(state.mcpServers.message).toBe("");
  });

  test("resets the form when starting a new server", () => {
    const state = {mcpServers: {error: "old error", message: "old message", form: {editing: true, name: "old"}}};

    resetMcpServerFormState(state);

    expect(state.mcpServers.form).toEqual({
      name: "",
      transport: "stdio",
      command: "",
      args: "",
      url: "",
      env: "",
    });
    expect(state.mcpServers.error).toBe("");
    expect(state.mcpServers.message).toBe("");
  });
});
