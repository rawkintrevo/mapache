import {render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, it, expect, vi} from "vitest";
import {VmWorkspaceEditModal} from "./VmWorkspaceEditModal.jsx";

function fixture() {
  const config = {generation: 11, desiredVersion: 2, appliedVersion: 2, state: "applied", restartRequired: false,
    desired: {authSelection: {harness: "pi", providers: {}}, environmentEntryIds: []}};
  const api = {getMachineConfiguration: vi.fn(async () => structuredClone(config)),
    getPiAuth: vi.fn(async () => ({entries: {key: {providerKey: "openai", label: "Work account", credential: {key: "never-render-secret"}}}})),
    getGenericEnvironmentKeys: vi.fn(async () => ({entries: [{id: "env", name: "SERVICE_KEY", label: "Service"}]})),
    updateMachineConfiguration: vi.fn(async (_id, payload) => ({...config, desiredVersion: 3, state: "pending-restart", restartRequired: true,
      desired: {authSelection: payload.authSelection, environmentEntryIds: payload.environmentEntryIds}}))};
  render(<VmWorkspaceEditModal workspace={{id: "vm", name: "My VM"}} api={api} onClose={vi.fn()} />);
  return {api, config, user: userEvent.setup()};
}
describe("VM workspace settings", () => {
  it("shows labels without secrets and saves the loaded generation/version without restarting", async () => {
    const f = fixture();
    await screen.findByText("Saved settings are applied.");
    expect(document.body.textContent).not.toContain("never-render-secret");
    await f.user.selectOptions(screen.getByRole("combobox", {name: "OpenAI credential"}), "key");
    await f.user.click(screen.getByRole("checkbox", {name: /Service/}));
    await f.user.click(screen.getByRole("button", {name: "Save settings"}));
    await screen.findByText("Saved. Restart required to apply saved settings.");
    expect(f.api.updateMachineConfiguration).toHaveBeenCalledWith("vm", {expectedGeneration: 11, expectedVersion: 2,
      authSelection: {harness: "pi", providers: {openai: "key"}}, environmentEntryIds: ["env"]});
  });
  it("keeps unsaved selections on conflict and reloads explicitly before retrying", async () => {
    const f = fixture();
    await screen.findByText("Saved settings are applied.");
    f.api.updateMachineConfiguration.mockRejectedValueOnce(new Error("vm_configuration_version_mismatch"));
    await f.user.selectOptions(screen.getByRole("combobox", {name: "OpenAI credential"}), "key");
    await f.user.click(screen.getByRole("button", {name: "Save settings"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved settings");
    expect(screen.getByRole("combobox", {name: "OpenAI credential"})).toHaveValue("key");
    f.config.desiredVersion = 4;
    await f.user.click(screen.getByRole("button", {name: "Reload saved settings"}));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", {name: "OpenAI credential"})).toHaveValue("");
    await f.user.click(screen.getByRole("button", {name: "Save settings"}));
    await waitFor(() => expect(f.api.updateMachineConfiguration.mock.lastCall[1].expectedVersion).toBe(4));
  });
});
