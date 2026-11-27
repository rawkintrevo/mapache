import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {WorkspaceModal} from "./WorkspaceModal.jsx";

function renderModal(remoteHostState = {hosts: [], loading: false}) {
  const props = {
    environmentEntries: [],
    onClose: vi.fn(),
    onConnectGithub: vi.fn(),
    onCreateWorkspace: vi.fn(),
    onLoadConnectedRepos: vi.fn(),
    onLoadRemoteHosts: vi.fn(),
    onShowRemoteHosts: vi.fn(),
    remoteHostState,
    repoPicker: {repos: [], loading: false, error: ""},
  };
  render(<WorkspaceModal {...props} />);
  return props;
}

describe("WorkspaceModal remote VM option", () => {
  test("keeps blank creation unchanged", async () => {
    const user = userEvent.setup();
    const props = renderModal();
    await user.type(screen.getByLabelText("Workspace Name"), "Blank workspace");
    await user.click(screen.getByRole("button", {name: "Create Workspace"}));

    expect(props.onCreateWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      name: "Blank workspace",
      source: {type: "blank", repoUrl: "", requestedBranch: null},
      repoUrl: "",
      branch: null,
      env: {},
    }));
  });

  test("shows resource defaults and submits the ready host identity", async () => {
    const user = userEvent.setup();
    const props = renderModal({
      hosts: [{id: "host-1", displayName: "Home machine", address: "home.example.com", status: "ready", ready: true}],
      loading: false,
      remoteVmAdmissionEnabled: true,
    });
    await user.click(screen.getByRole("radio", {name: "VM on remote machine"}));
    expect(screen.getByLabelText("Virtual CPUs")).toHaveValue(2);
    expect(screen.getByLabelText("Memory (GiB)")).toHaveValue(8);
    await user.clear(screen.getByLabelText("Virtual CPUs"));
    await user.type(screen.getByLabelText("Virtual CPUs"), "3");
    expect(screen.getByText("Home machine")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Workspace Name"), "Remote workspace");
    await user.click(screen.getByRole("button", {name: "Create Workspace"}));

    expect(props.onLoadRemoteHosts).toHaveBeenCalled();
    expect(props.onCreateWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      name: "Remote workspace",
      resources: {cpu: "3", memory: "8Gi"},
      source: {type: "remote-libvirt", hostId: "host-1"},
    }));
  });

  test("blocks remote creation until the host is ready", async () => {
    const user = userEvent.setup();
    const props = renderModal({hosts: [{id: "host-1", status: "unreachable"}], loading: false, remoteVmAdmissionEnabled: true});
    await user.click(screen.getByRole("radio", {name: "VM on remote machine"}));
    expect(screen.getByRole("button", {name: "Create Workspace"})).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("not ready");
    expect(props.onCreateWorkspace).not.toHaveBeenCalled();
  });

  test("keeps remote creation disabled until the backend rollout switch is loaded", () => {
    renderModal({hosts: [], loading: false, attempted: false, remoteVmAdmissionEnabled: false});

    expect(screen.getByRole("radio", {name: "VM on remote machine"})).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking remote VM availability");
  });
});
