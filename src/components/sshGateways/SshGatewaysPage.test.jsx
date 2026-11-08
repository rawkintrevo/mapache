import {render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {SshGatewaysPage} from "./SshGatewaysPage.jsx";

function state(overrides = {}) {
  return {
    sshGateways: {
      attempted: true,
      loading: false,
      saving: false,
      error: "",
      message: "",
      gateways: [{
        id: "gateway-a",
        host: "gateway.example.com",
        port: 22,
        user: "mapache_tunnel",
        enabled: true,
        workspaceIds: ["workspace-1"],
        workspaces: [{id: "workspace-1", name: "Research"}],
      }],
      workspaces: [
        {id: "workspace-1", name: "Research"},
        {id: "workspace-2", name: "Production"},
      ],
      ...overrides,
    },
  };
}

describe("SSH gateways page", () => {
  test("saves multiple owned workspace assignments and explains restart behavior", async () => {
    const user = userEvent.setup();
    const onSaveAssignments = vi.fn();
    render(<SshGatewaysPage state={state()} onSaveAssignments={onSaveAssignments} />);

    const card = screen.getByRole("region", {name: "gateway.example.com:22"});
    await user.click(within(card).getByRole("checkbox", {name: "Allow Production to use gateway.example.com:22"}));
    await user.click(within(card).getByRole("button", {name: "Save workspace access"}));

    expect(onSaveAssignments).toHaveBeenCalledWith("gateway-a", ["workspace-1", "workspace-2"]);
    expect(screen.getByText(/Running sessions keep their current route until you explicitly restart them/)).toBeInTheDocument();
  });

  test("shows loading and error states", () => {
    render(<SshGatewaysPage state={state({attempted: true, loading: false, error: "Gateway service unavailable", gateways: []})} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Gateway service unavailable");
    expect(screen.getByText("No SSH gateways are configured")).toBeInTheDocument();
  });
});
